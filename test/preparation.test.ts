import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  MineruMarkdownUnavailableError,
  PreparationAttemptSupersededError,
  beginPreparationAttempt,
  createPreparationRecord,
  countTerminologyEntries,
  migrateTerminologyMarkdown,
  getPreparationRetryScope,
  paperIndexMatches,
  persistBackgroundResearch,
  persistCoreBackground,
  preparePaperContext,
  readPreparationRecord,
  setPreparationStage,
  updatePreparationStages,
  validateCoreBackgroundMarkdown,
  validateExistingPaperSourceRecord,
} from "../src/context/runtime";
import {
  buildPaperIndex,
  createBackgroundMarkdown,
  createTerminologyMarkdown,
} from "../src/context/paperContext";

test("unlocks core translation before optional external research finishes", () => {
  const initial = createPreparationRecord(
    "ABCD1234",
    "hash",
    "2026-01-01T00:00:00Z",
  );
  const core = updatePreparationStages(
    initial,
    [
      { id: "source", status: "complete" },
      { id: "index", status: "complete" },
      { id: "background", status: "complete" },
      { id: "terminology", status: "complete" },
    ],
    "2026-01-01T00:01:00Z",
  );
  assert.equal(core.overall, "core-ready");
  const warning = updatePreparationStages(
    core,
    [{ id: "external", status: "warning", detail: "rate limited" }],
    "2026-01-01T00:02:00Z",
  );
  assert.equal(warning.overall, "ready");
});

test("migrates legacy terminology while preserving the human translation", () => {
  const migrated = migrateTerminologyMarkdown(
    [
      "# Terminology: Paper",
      "",
      "| Source | Translation | Evidence | Updated at |",
      "| --- | --- | --- | --- |",
      "| timing arc | 时序弧 | Methods | 2026-01-01 |",
      "",
    ].join("\n"),
    "Paper",
  );
  assert.match(migrated, /\| timing arc \| timing arc \| 时序弧 \| legacy \|/);
});

test("revalidates preserved terminology against an updated Markdown version", () => {
  const current = [
    "# Terminology: Paper",
    "",
    "| Observed expression | Canonical English | Preferred Chinese | Category | Definition | Paper evidence | Source level | Confidence | Updated at |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    "| timing arc | timing arc | 人工译法 | EDA | relation | Method | paper | high | 2026-01-01 |",
    "| removed term | removed term | 旧译法 | EDA | old | Old | paper | high | 2026-01-01 |",
    "",
  ].join("\n");
  const migrated = migrateTerminologyMarkdown(
    current,
    "Paper",
    "# Method\nA timing arc is characterized.",
  );
  assert.match(migrated, /人工译法/);
  assert.doesNotMatch(migrated, /removed term/);

  const wrongCase = migrateTerminologyMarkdown(
    current.replace(/timing arc/g, "HGAT"),
    "Paper",
    "# Method\nhgat is used here.",
  );
  assert.doesNotMatch(wrongCase, /人工译法/);
});

test("keeps completed stages monotonic and enforces stage order", () => {
  let record = createPreparationRecord(
    "ABCD1234",
    "hash",
    "2026-01-01T00:00:00Z",
  );
  record = updatePreparationStages(record, [
    { id: "source", status: "complete" },
    { id: "index", status: "complete" },
  ]);
  const outOfOrder = updatePreparationStages(record, [
    { id: "terminology", status: "running" },
  ]);
  assert.equal(
    outOfOrder.stages.find((stage) => stage.id === "terminology")?.status,
    "pending",
  );
  record = updatePreparationStages(record, [
    { id: "background", status: "running" },
  ]);
  record = updatePreparationStages(record, [
    { id: "background", status: "complete" },
  ]);
  const completed = record;
  record = updatePreparationStages(record, [
    { id: "background", status: "complete", detail: "late overwrite" },
  ]);
  assert.equal(record, completed);
  assert.equal(
    record.stages.find((stage) => stage.id === "background")?.detail,
    undefined,
  );
  record = updatePreparationStages(record, [
    { id: "background", status: "error" },
  ]);
  assert.equal(
    record.stages.find((stage) => stage.id === "background")?.status,
    "complete",
  );

  let failed = createPreparationRecord(
    "EFGH5678",
    "hash",
    "2026-01-01T00:00:00Z",
  );
  failed = updatePreparationStages(failed, [
    { id: "source", status: "complete" },
    { id: "index", status: "complete" },
    { id: "background", status: "error" },
  ]);
  failed = updatePreparationStages(failed, [
    { id: "background", status: "complete" },
  ]);
  assert.equal(
    failed.stages.find((stage) => stage.id === "background")?.status,
    "error",
  );
});

test("classifies absent and partial MinerU caches without exposing paths", async () => {
  const previousIO = (globalThis as any).IOUtils;
  const previousZotero = (globalThis as any).Zotero;
  const dataDir = "E:\\ZoteroData";
  const cacheDir = `${dataDir}\\llm-for-zotero-mineru\\42`;
  const attachment = {
    id: 42,
    key: "WXYZ5678",
    parentItemID: 7,
    isAttachment: () => true,
  };
  const parent = {
    id: 7,
    key: "ABCD1234",
    libraryID: 1,
    isAttachment: () => false,
    getField: () => "",
  };
  (globalThis as any).Zotero = {
    DataDirectory: { dir: dataDir },
    Items: {
      get(id: number) {
        return id === 42 ? attachment : parent;
      },
    },
  };
  try {
    (globalThis as any).IOUtils = {
      async exists() {
        return false;
      },
    };
    await assert.rejects(preparePaperContext(42, ""), (error: unknown) => {
      assert.ok(error instanceof MineruMarkdownUnavailableError);
      assert.equal(error.reason, "not-generated");
      assert.deepEqual(error.missingFiles, [
        "_llm_source.json",
        "full.md",
        "manifest.json",
      ]);
      assert.doesNotMatch(error.message, /E:\\/);
      return true;
    });

    (globalThis as any).IOUtils = {
      async exists(path: string) {
        return path === `${cacheDir}\\_llm_source.json`;
      },
    };
    await assert.rejects(preparePaperContext(42, ""), (error: unknown) => {
      assert.ok(error instanceof MineruMarkdownUnavailableError);
      assert.equal(error.reason, "incomplete-cache");
      assert.deepEqual(error.missingFiles, ["full.md", "manifest.json"]);
      assert.doesNotMatch(error.message, /E:\\/);
      return true;
    });
  } finally {
    (globalThis as any).IOUtils = previousIO;
    (globalThis as any).Zotero = previousZotero;
  }
});

test("archives a failed attempt and fences late knowledge writes", async () => {
  const previousIO = (globalThis as any).IOUtils;
  const paperDir = "E:\\ZoteroData\\paper-translate-for-zotero\\ABCD1234";
  const mineruCacheDir = "E:\\ZoteroData\\llm-for-zotero-mineru\\42";
  const fullMdPath = `${mineruCacheDir}\\full.md`;
  const sourcePath = `${paperDir}\\_paper_source.json`;
  const preparationPath = `${paperDir}\\_preparation.json`;
  const markdown = "# Paper\nValidated Markdown";
  const fullMdSha256 = createHash("sha256").update(markdown).digest("hex");
  let preparation = createPreparationRecord(
    "ABCD1234",
    fullMdSha256,
    "2026-07-20T00:00:00.000Z",
  );
  preparation = updatePreparationStages(preparation, [
    { id: "source", status: "complete" },
    { id: "index", status: "complete" },
    {
      id: "background",
      status: "error",
      detail: "Codex quota exhausted",
      failureKind: "request",
    },
    {
      id: "terminology",
      status: "skipped",
      detail: "论文背景阶段未完成",
    },
    {
      id: "external",
      status: "skipped",
      detail: "核心知识阶段未完成",
    },
  ]);
  const files = new Map<string, string>([
    [
      sourcePath,
      JSON.stringify({
        schemaVersion: 3,
        libraryID: 1,
        parentItemKey: "ABCD1234",
        attachmentID: 42,
        attachmentKey: "WXYZ5678",
        title: "Paper",
        doi: "",
        mineruCacheDir,
        fullMdPath,
        fullMdSha256,
        updatedAt: "2026-07-20T00:00:00.000Z",
      }),
    ],
    [preparationPath, JSON.stringify(preparation)],
    [fullMdPath, markdown],
  ]);
  (globalThis as any).IOUtils = {
    async exists(path: string) {
      return files.has(path);
    },
    async read(path: string) {
      return new TextEncoder().encode(files.get(path) || "");
    },
    async write(path: string, data: Uint8Array) {
      files.set(path, new TextDecoder().decode(data));
    },
  };
  const context = {
    paperDir,
    mineruCacheDir,
    fullMdPath,
    fullMdSha256,
    identity: {
      libraryID: 1,
      parentItemKey: "ABCD1234",
      attachmentID: 42,
      attachmentKey: "WXYZ5678",
    },
  } as any;
  try {
    assert.equal(getPreparationRetryScope(preparation), "core");
    const retried = await beginPreparationAttempt(context, "core");
    assert.equal(retried.attemptId, 2);
    assert.equal(retried.attemptHistory.length, 1);
    assert.equal(retried.attemptHistory[0].stages[0].status, "error");
    assert.equal(
      retried.stages.find((stage) => stage.id === "background")?.status,
      "pending",
    );
    assert.equal(
      retried.stages.find((stage) => stage.id === "source")?.status,
      "complete",
    );
    const corruptedHistory = structuredClone(retried) as any;
    corruptedHistory.attemptHistory[0].stages[0].status = "corrupt-status";
    files.set(preparationPath, JSON.stringify(corruptedHistory));
    await assert.rejects(readPreparationRecord(context), /does not match/);
    files.set(preparationPath, JSON.stringify(retried));
    await assert.rejects(
      setPreparationStage({
        context,
        expectedAttempt: 1,
        id: "background",
        status: "running",
      }),
      PreparationAttemptSupersededError,
    );
    const running = await setPreparationStage({
      context,
      expectedAttempt: 2,
      id: "background",
      status: "running",
    });
    assert.equal(
      running.stages.find((stage) => stage.id === "background")?.status,
      "running",
    );
  } finally {
    (globalThis as any).IOUtils = previousIO;
  }
});

test("rejects damaged persisted indexes instead of marking them complete", () => {
  const markdown = "# Method\nA timing arc is characterized.";
  const expected = buildPaperIndex({
    parentItemKey: "ABCD1234",
    fullMdSha256: "hash",
    manifestSha256: "manifest",
    markdown,
    manifest: { noSections: true, totalChars: markdown.length },
    updatedAt: "2026-07-17T00:00:00.000Z",
  });
  assert.equal(paperIndexMatches(expected, expected), true);
  assert.equal(paperIndexMatches({ ...expected, chunks: [] }, expected), false);
  assert.equal(
    paperIndexMatches(
      {
        ...expected,
        chunks: expected.chunks.map((chunk) => ({
          ...chunk,
          charEnd: markdown.length + 1,
        })),
      },
      expected,
    ),
    false,
  );
});

test("allows only supported source schemas with complete identity and paths", () => {
  const expected = {
    schemaVersion: 3,
    libraryID: 1,
    parentItemKey: "ABCD1234",
    attachmentID: 42,
    attachmentKey: "WXYZ5678",
    title: "Paper",
    doi: "10.1000/example",
    mineruCacheDir: "E:\\ZoteroData\\llm-for-zotero-mineru\\42",
    fullMdPath: "E:\\ZoteroData\\llm-for-zotero-mineru\\42\\full.md",
    fullMdSha256: "a".repeat(64),
    updatedAt: "2026-07-17T00:00:00.000Z",
  } as const;
  assert.equal(
    validateExistingPaperSourceRecord(
      { ...expected, schemaVersion: 1 },
      expected,
      "source.json",
    ).schemaVersion,
    1,
  );
  assert.throws(
    () =>
      validateExistingPaperSourceRecord(
        { ...expected, schemaVersion: 999 },
        expected,
        "source.json",
      ),
    /invalid or conflicting/,
  );
  assert.throws(
    () =>
      validateExistingPaperSourceRecord(
        { ...expected, fullMdSha256: "broken" },
        expected,
        "source.json",
      ),
    /invalid or conflicting/,
  );
});

test("refuses a late knowledge write after the full Markdown hash changes", async () => {
  const previousIO = (globalThis as any).IOUtils;
  const paperDir = "E:\\ZoteroData\\paper-translate-for-zotero\\ABCD1234";
  const sourcePath = `${paperDir}\\_paper_source.json`;
  const backgroundPath = `${paperDir}\\background.md`;
  const files = new Map<string, string>([
    [
      sourcePath,
      JSON.stringify({
        schemaVersion: 3,
        libraryID: 1,
        parentItemKey: "ABCD1234",
        attachmentID: 42,
        attachmentKey: "WXYZ5678",
        mineruCacheDir: "E:\\ZoteroData\\llm-for-zotero-mineru\\42",
        fullMdPath: "E:\\ZoteroData\\llm-for-zotero-mineru\\42\\full.md",
        fullMdSha256: "b".repeat(64),
      }),
    ],
    [backgroundPath, "original"],
  ]);
  (globalThis as any).IOUtils = {
    async exists(path: string) {
      return files.has(path);
    },
    async read(path: string) {
      return new TextEncoder().encode(files.get(path) || "");
    },
    async write(path: string, data: Uint8Array) {
      files.set(path, new TextDecoder().decode(data));
    },
  };
  try {
    await assert.rejects(
      persistCoreBackground({
        context: {
          paperDir,
          mineruCacheDir: "E:\\ZoteroData\\llm-for-zotero-mineru\\42",
          fullMdPath: "E:\\ZoteroData\\llm-for-zotero-mineru\\42\\full.md",
          fullMdSha256: "a".repeat(64),
          identity: {
            libraryID: 1,
            parentItemKey: "ABCD1234",
            attachmentID: 42,
            attachmentKey: "WXYZ5678",
          },
        } as any,
        expectedAttempt: 1,
        markdown: [
          "## 论文依据",
          "### 所属领域",
          "EDA",
          "### 研究问题",
          "Delay",
          "### 工作流",
          "Characterization",
          "### 方法组件",
          "HGAT",
          "### 实验与评价语境",
          "rRMSE",
        ].join("\n"),
      }),
      /context changed/,
    );
    assert.equal(files.get(backgroundPath), "original");
  } finally {
    (globalThis as any).IOUtils = previousIO;
  }
});

test("refuses a knowledge write when the physical MinerU Markdown changed", async () => {
  const previousIO = (globalThis as any).IOUtils;
  const paperDir = "E:\\ZoteroData\\paper-translate-for-zotero\\ABCD1234";
  const mineruCacheDir = "E:\\ZoteroData\\llm-for-zotero-mineru\\42";
  const fullMdPath = `${mineruCacheDir}\\full.md`;
  const sourcePath = `${paperDir}\\_paper_source.json`;
  const backgroundPath = `${paperDir}\\background.md`;
  const originalMarkdown = "# Original\nValidated source";
  const changedMarkdown = "# Changed\nNew source";
  const fullMdSha256 = createHash("sha256")
    .update(originalMarkdown)
    .digest("hex");
  const files = new Map<string, string>([
    [
      sourcePath,
      JSON.stringify({
        schemaVersion: 3,
        libraryID: 1,
        parentItemKey: "ABCD1234",
        attachmentID: 42,
        attachmentKey: "WXYZ5678",
        mineruCacheDir,
        fullMdPath,
        fullMdSha256,
      }),
    ],
    [fullMdPath, changedMarkdown],
    [backgroundPath, "original"],
  ]);
  (globalThis as any).IOUtils = {
    async exists(path: string) {
      return files.has(path);
    },
    async read(path: string) {
      return new TextEncoder().encode(files.get(path) || "");
    },
    async write(path: string, data: Uint8Array) {
      files.set(path, new TextDecoder().decode(data));
    },
  };
  try {
    await assert.rejects(
      persistCoreBackground({
        context: {
          paperDir,
          mineruCacheDir,
          fullMdPath,
          fullMdSha256,
          identity: {
            libraryID: 1,
            parentItemKey: "ABCD1234",
            attachmentID: 42,
            attachmentKey: "WXYZ5678",
          },
        } as any,
        expectedAttempt: 1,
        markdown: validCoreBackground(),
      }),
      /MinerU full\.md changed/,
    );
    assert.equal(files.get(backgroundPath), "original");
  } finally {
    (globalThis as any).IOUtils = previousIO;
  }
});

test("serializes concurrent preparation writes without losing completion", async () => {
  const previousIO = (globalThis as any).IOUtils;
  const paperDir = "E:\\ZoteroData\\paper-translate-for-zotero\\ABCD1234";
  const preparationPath = `${paperDir}\\_preparation.json`;
  const sourcePath = `${paperDir}\\_paper_source.json`;
  const mineruCacheDir = "E:\\ZoteroData\\llm-for-zotero-mineru\\42";
  const fullMdPath = `${mineruCacheDir}\\full.md`;
  const markdown = "# Paper\nValidated Markdown";
  const fullMdSha256 = createHash("sha256").update(markdown).digest("hex");
  let initial = createPreparationRecord("ABCD1234", fullMdSha256);
  initial = updatePreparationStages(initial, [
    { id: "source", status: "complete" },
    { id: "index", status: "complete" },
  ]);
  const files = new Map([
    [preparationPath, JSON.stringify(initial)],
    [
      sourcePath,
      JSON.stringify({
        schemaVersion: 3,
        libraryID: 1,
        parentItemKey: "ABCD1234",
        attachmentID: 42,
        attachmentKey: "WXYZ5678",
        mineruCacheDir,
        fullMdPath,
        fullMdSha256,
      }),
    ],
    [fullMdPath, markdown],
  ]);
  (globalThis as any).IOUtils = {
    async exists(path: string) {
      return files.has(path);
    },
    async read(path: string) {
      return new TextEncoder().encode(files.get(path) || "");
    },
    async write(path: string, data: Uint8Array) {
      const text = new TextDecoder().decode(data);
      const status = JSON.parse(text).stages.find(
        (stage: { id: string }) => stage.id === "background",
      )?.status;
      await new Promise((resolve) =>
        setTimeout(resolve, status === "running" ? 20 : 1),
      );
      files.set(path, text);
    },
  };
  const context = {
    paperDir,
    mineruCacheDir,
    fullMdPath,
    identity: {
      libraryID: 1,
      parentItemKey: "ABCD1234",
      attachmentID: 42,
      attachmentKey: "WXYZ5678",
    },
    fullMdSha256,
  } as any;
  try {
    await Promise.all([
      setPreparationStage({
        context,
        expectedAttempt: 1,
        id: "background",
        status: "running",
      }),
      setPreparationStage({
        context,
        expectedAttempt: 1,
        id: "background",
        status: "complete",
      }),
    ]);
    const final = JSON.parse(files.get(preparationPath) || "{}");
    assert.equal(
      final.stages.find((stage: { id: string }) => stage.id === "background")
        .status,
      "complete",
    );
  } finally {
    (globalThis as any).IOUtils = previousIO;
  }
});

test("reopening preserves active work and isolates invalid optional knowledge", async () => {
  const previousIO = (globalThis as any).IOUtils;
  const previousZotero = (globalThis as any).Zotero;
  const dataDir = "E:\\ZoteroData";
  const mineruCacheDir = `${dataDir}\\llm-for-zotero-mineru\\42`;
  const paperDir = `${dataDir}\\paper-translate-for-zotero\\ABCD1234`;
  const fullMdPath = `${mineruCacheDir}\\full.md`;
  const provenancePath = `${mineruCacheDir}\\_llm_source.json`;
  const manifestPath = `${mineruCacheDir}\\manifest.json`;
  const sourcePath = `${paperDir}\\_paper_source.json`;
  const preparationPath = `${paperDir}\\_preparation.json`;
  const backgroundPath = `${paperDir}\\background.md`;
  const terminologyPath = `${paperDir}\\terminology.md`;
  const sourcesPath = `${paperDir}\\background-sources.json`;
  const markdown = "# Method\nThe reduction preserves the timing arc.";
  const fullMdSha256 = createHash("sha256").update(markdown).digest("hex");
  const manifest = JSON.stringify({
    noSections: true,
    totalChars: markdown.length,
  });
  let preparation = createPreparationRecord("ABCD1234", fullMdSha256);
  preparation = updatePreparationStages(preparation, [
    { id: "source", status: "complete" },
    { id: "index", status: "complete" },
    { id: "background", status: "running" },
  ]);
  const files = new Map<string, string>([
    [
      provenancePath,
      JSON.stringify({
        kind: "llm-for-zotero/mineru-cache-source",
        version: 2,
        attachmentId: 42,
        attachmentKey: "WXYZ5678",
        parentItemKey: "ABCD1234",
        origin: "parsed",
        recordedAt: "2026-07-18T00:00:00.000Z",
      }),
    ],
    [fullMdPath, markdown],
    [manifestPath, manifest],
    [
      sourcePath,
      JSON.stringify({
        schemaVersion: 3,
        libraryID: 1,
        parentItemKey: "ABCD1234",
        attachmentID: 42,
        attachmentKey: "WXYZ5678",
        title: "Paper",
        doi: "10.1000/example",
        mineruCacheDir,
        fullMdPath,
        fullMdSha256,
        updatedAt: "2026-07-18T00:00:00.000Z",
      }),
    ],
    [preparationPath, JSON.stringify(preparation)],
    [backgroundPath, createBackgroundMarkdown("Paper")],
    [terminologyPath, createTerminologyMarkdown("Paper")],
    [
      sourcesPath,
      JSON.stringify({
        schemaVersion: 3,
        parentItemKey: "ABCD1234",
        fullMdSha256,
        status: "pending",
        queries: [],
        sources: [],
        failures: [],
      }),
    ],
  ]);
  (globalThis as any).IOUtils = {
    async exists(path: string) {
      return files.has(path);
    },
    async read(path: string) {
      return new TextEncoder().encode(files.get(path) || "");
    },
    async write(path: string, data: Uint8Array) {
      files.set(path, new TextDecoder().decode(data));
    },
    async makeDirectory() {},
    async getChildren() {
      return [];
    },
  };
  const attachment = {
    id: 42,
    key: "WXYZ5678",
    parentItemID: 7,
    isAttachment: () => true,
  };
  const parent = {
    id: 7,
    key: "ABCD1234",
    libraryID: 1,
    isAttachment: () => false,
    getField: (field: string) =>
      field === "title" ? "Paper" : field === "DOI" ? "10.1000/example" : "",
  };
  (globalThis as any).Zotero = {
    DataDirectory: { dir: dataDir },
    Items: { get: (id: number) => (id === 42 ? attachment : parent) },
  };
  try {
    const context = await preparePaperContext(42, "re-duction");
    const current = JSON.parse(files.get(preparationPath) || "{}");
    assert.equal(
      current.stages.find((stage: { id: string }) => stage.id === "background")
        .status,
      "running",
    );
    assert.equal(context.alignedQuery, "reduction");
    assert.match(
      context.passages.map((passage) => passage.text).join("\n"),
      /reduction/,
    );

    const completed = updatePreparationStages(current, [
      { id: "background", status: "complete" },
    ]);
    files.set(preparationPath, JSON.stringify(completed));
    files.set(
      backgroundPath,
      "# Background: Paper\n\n## 论文依据\n### 所属领域\nEDA\n",
    );
    const recovered = await preparePaperContext(42, "timing arc");
    const stopped = JSON.parse(files.get(preparationPath) || "{}");
    assert.equal(recovered.background, "");
    assert.equal(
      stopped.integrityIssues.find(
        (issue: { stage: string }) => issue.stage === "background",
      ).stage,
      "background",
    );
    assert.equal(
      stopped.stages.find((stage: { id: string }) => stage.id === "terminology")
        .status,
      "skipped",
    );
    assert.equal(
      stopped.stages.find((stage: { id: string }) => stage.id === "external")
        .status,
      "skipped",
    );
  } finally {
    (globalThis as any).IOUtils = previousIO;
    (globalThis as any).Zotero = previousZotero;
  }
});

test("rejects duplicate or extra preparation stages", async () => {
  const previousIO = (globalThis as any).IOUtils;
  const paperDir = "E:\\ZoteroData\\paper-translate-for-zotero\\ABCD1234";
  const path = `${paperDir}\\_preparation.json`;
  const invalid = createPreparationRecord("ABCD1234", "hash");
  invalid.stages.push({ ...invalid.stages[0] });
  (globalThis as any).IOUtils = {
    async exists(value: string) {
      return value === path;
    },
    async read() {
      return new TextEncoder().encode(JSON.stringify(invalid));
    },
  };
  try {
    await assert.rejects(
      readPreparationRecord({
        paperDir,
        identity: { parentItemKey: "ABCD1234" },
        fullMdSha256: "hash",
      } as any),
      /does not match/,
    );
  } finally {
    (globalThis as any).IOUtils = previousIO;
  }
});

test("migrates a legacy terminal failure without reopening it", async () => {
  const previousIO = (globalThis as any).IOUtils;
  const paperDir = "E:\\ZoteroData\\paper-translate-for-zotero\\ABCD1234";
  const path = `${paperDir}\\_preparation.json`;
  let legacy: any = createPreparationRecord("ABCD1234", "hash");
  legacy = updatePreparationStages(legacy, [
    { id: "source", status: "complete" },
    { id: "index", status: "complete" },
    { id: "background", status: "error", detail: "legacy 400" },
    { id: "terminology", status: "skipped" },
    { id: "external", status: "skipped" },
  ]);
  delete legacy.preparationSchemaVersion;
  delete legacy.attemptId;
  delete legacy.attemptTrigger;
  delete legacy.attemptStartedAt;
  delete legacy.attemptHistory;
  (globalThis as any).IOUtils = {
    async exists(value: string) {
      return value === path;
    },
    async read() {
      return new TextEncoder().encode(JSON.stringify(legacy));
    },
  };
  try {
    const migrated = await readPreparationRecord({
      paperDir,
      identity: { parentItemKey: "ABCD1234" },
      fullMdSha256: "hash",
    } as any);
    assert.equal(migrated.attemptId, 1);
    assert.equal(migrated.attemptHistory.length, 0);
    assert.equal(
      migrated.stages.find((stage) => stage.id === "background")?.status,
      "error",
    );
    assert.equal(
      migrated.stages.find((stage) => stage.id === "background")?.failureKind,
      "legacy-unclassified",
    );
    assert.equal(getPreparationRetryScope(migrated), "core");
  } finally {
    (globalThis as any).IOUtils = previousIO;
  }
});

test("rejects current preparation records with missing attempt metadata", async () => {
  const previousIO = (globalThis as any).IOUtils;
  const paperDir = "E:\\ZoteroData\\paper-translate-for-zotero\\ABCD1234";
  const path = `${paperDir}\\_preparation.json`;
  const context = {
    paperDir,
    identity: { parentItemKey: "ABCD1234" },
    fullMdSha256: "hash",
  } as any;
  try {
    for (const field of [
      "attemptId",
      "attemptTrigger",
      "attemptStartedAt",
      "attemptHistory",
    ] as const) {
      const invalid: any = createPreparationRecord("ABCD1234", "hash");
      delete invalid[field];
      (globalThis as any).IOUtils = {
        async exists(value: string) {
          return value === path;
        },
        async read() {
          return new TextEncoder().encode(JSON.stringify(invalid));
        },
      };
      await assert.rejects(
        readPreparationRecord(context),
        /does not match/,
        `missing ${field} must not be silently migrated`,
      );
    }
  } finally {
    (globalThis as any).IOUtils = previousIO;
  }
});

test("rejects an inconsistent preparation overall value", async () => {
  const previousIO = (globalThis as any).IOUtils;
  const paperDir = "E:\\ZoteroData\\paper-translate-for-zotero\\ABCD1234";
  const path = `${paperDir}\\_preparation.json`;
  const invalid = {
    ...createPreparationRecord("ABCD1234", "hash"),
    overall: "ready",
  };
  (globalThis as any).IOUtils = {
    async exists(value: string) {
      return value === path;
    },
    async read() {
      return new TextEncoder().encode(JSON.stringify(invalid));
    },
  };
  try {
    await assert.rejects(
      readPreparationRecord({
        paperDir,
        identity: { parentItemKey: "ABCD1234" },
        fullMdSha256: "hash",
      } as any),
      /overall status is inconsistent/,
    );
  } finally {
    (globalThis as any).IOUtils = previousIO;
  }
});

test("rolls back the source record when external background writing fails", async () => {
  const previousIO = (globalThis as any).IOUtils;
  const paperDir = "E:\\ZoteroData\\paper-translate-for-zotero\\ABCD1234";
  const mineruCacheDir = "E:\\ZoteroData\\llm-for-zotero-mineru\\42";
  const fullMdPath = `${mineruCacheDir}\\full.md`;
  const sourcePath = `${paperDir}\\_paper_source.json`;
  const preparationPath = `${paperDir}\\_preparation.json`;
  const backgroundPath = `${paperDir}\\background.md`;
  const sourcesPath = `${paperDir}\\background-sources.json`;
  const markdown = "# Paper\nValidated source";
  const fullMdSha256 = createHash("sha256").update(markdown).digest("hex");
  const previousSources = JSON.stringify({
    schemaVersion: 3,
    parentItemKey: "ABCD1234",
    fullMdSha256,
    status: "pending",
    queries: [],
    sources: [],
    failures: [],
  });
  let preparation = createPreparationRecord("ABCD1234", fullMdSha256);
  preparation = updatePreparationStages(preparation, [
    { id: "source", status: "complete" },
    { id: "index", status: "complete" },
  ]);
  const background = `# Background: Paper\n\n${validCoreBackground()}\n`;
  const files = new Map<string, string>([
    [
      sourcePath,
      JSON.stringify({
        schemaVersion: 3,
        libraryID: 1,
        parentItemKey: "ABCD1234",
        attachmentID: 42,
        attachmentKey: "WXYZ5678",
        mineruCacheDir,
        fullMdPath,
        fullMdSha256,
      }),
    ],
    [preparationPath, JSON.stringify(preparation)],
    [fullMdPath, markdown],
    [backgroundPath, background],
    [sourcesPath, previousSources],
  ]);
  let backgroundWrites = 0;
  (globalThis as any).IOUtils = {
    async exists(path: string) {
      return files.has(path);
    },
    async read(path: string) {
      return new TextEncoder().encode(files.get(path) || "");
    },
    async write(path: string, data: Uint8Array) {
      if (path === backgroundPath) {
        backgroundWrites += 1;
        throw new Error("background write failed");
      }
      files.set(path, new TextDecoder().decode(data));
    },
  };
  const context = {
    paperDir,
    mineruCacheDir,
    fullMdPath,
    fullMdSha256,
    markdown,
    background,
    identity: {
      libraryID: 1,
      parentItemKey: "ABCD1234",
      attachmentID: 42,
      attachmentKey: "WXYZ5678",
      title: "Paper",
    },
  } as any;
  try {
    await assert.rejects(
      persistBackgroundResearch({
        context,
        expectedAttempt: 1,
        summary: "用于术语消歧的官方背景。",
        queries: ["official timing arc definition"],
        sources: [
          {
            title: "Official source",
            url: "https://example.org/standard",
            snippet: "A timing arc definition.",
            sourceLevel: "official",
            purpose: "术语消歧",
          },
        ],
      }),
      /background write failed/,
    );
    assert.equal(backgroundWrites, 1);
    assert.equal(files.get(backgroundPath), background);
    assert.equal(files.get(sourcesPath), previousSources);
    assert.equal(context.background, background);
  } finally {
    (globalThis as any).IOUtils = previousIO;
  }
});

test("retries only external knowledge and resets its paired files", async () => {
  const previousIO = (globalThis as any).IOUtils;
  const paperDir = "E:\\ZoteroData\\paper-translate-for-zotero\\ABCD1234";
  const mineruCacheDir = "E:\\ZoteroData\\llm-for-zotero-mineru\\42";
  const fullMdPath = `${mineruCacheDir}\\full.md`;
  const sourcePath = `${paperDir}\\_paper_source.json`;
  const preparationPath = `${paperDir}\\_preparation.json`;
  const backgroundPath = `${paperDir}\\background.md`;
  const sourcesPath = `${paperDir}\\background-sources.json`;
  const markdown = "# Paper\nValidated source";
  const fullMdSha256 = createHash("sha256").update(markdown).digest("hex");
  let preparation = createPreparationRecord("ABCD1234", fullMdSha256);
  preparation = updatePreparationStages(preparation, [
    { id: "source", status: "complete" },
    { id: "index", status: "complete" },
    { id: "background", status: "complete" },
    { id: "terminology", status: "complete" },
    {
      id: "external",
      status: "warning",
      detail: "1 个来源受限",
      failureKind: "request",
    },
  ]);
  const background = `# Background: Paper\n\n${validCoreBackground()}\n`;
  const files = new Map<string, string>([
    [
      sourcePath,
      JSON.stringify({
        schemaVersion: 3,
        libraryID: 1,
        parentItemKey: "ABCD1234",
        attachmentID: 42,
        attachmentKey: "WXYZ5678",
        title: "Paper",
        doi: "",
        mineruCacheDir,
        fullMdPath,
        fullMdSha256,
        updatedAt: "2026-07-20T00:00:00.000Z",
      }),
    ],
    [preparationPath, JSON.stringify(preparation)],
    [fullMdPath, markdown],
    [backgroundPath, background],
    [
      sourcesPath,
      JSON.stringify({
        schemaVersion: 3,
        parentItemKey: "ABCD1234",
        fullMdSha256,
        status: "warning",
        researchedAt: "2026-07-20T00:00:00.000Z",
        queries: ["official definition"],
        sources: [],
        failures: [{ provider: "web-search", message: "quota" }],
      }),
    ],
  ]);
  (globalThis as any).IOUtils = {
    async exists(path: string) {
      return files.has(path);
    },
    async read(path: string) {
      return new TextEncoder().encode(files.get(path) || "");
    },
    async write(path: string, data: Uint8Array) {
      files.set(path, new TextDecoder().decode(data));
    },
  };
  const context = {
    paperDir,
    mineruCacheDir,
    fullMdPath,
    fullMdSha256,
    background,
    identity: {
      libraryID: 1,
      parentItemKey: "ABCD1234",
      attachmentID: 42,
      attachmentKey: "WXYZ5678",
    },
  } as any;
  try {
    assert.equal(getPreparationRetryScope(preparation), "external");
    const inconsistentBackground = `${background.trimEnd()}\n\n## 外部背景补充\n\nunpaired summary\n`;
    files.set(backgroundPath, inconsistentBackground);
    context.background = inconsistentBackground;
    await assert.rejects(
      beginPreparationAttempt(context, "external"),
      /summary and source record are inconsistent/,
    );
    assert.equal(JSON.parse(files.get(preparationPath) || "{}").attemptId, 1);
    files.set(backgroundPath, background);
    context.background = background;
    const retried = await beginPreparationAttempt(context, "external");
    assert.equal(retried.attemptId, 2);
    assert.equal(
      retried.stages.find((stage) => stage.id === "background")?.status,
      "complete",
    );
    assert.equal(
      retried.stages.find((stage) => stage.id === "terminology")?.status,
      "complete",
    );
    assert.equal(
      retried.stages.find((stage) => stage.id === "external")?.status,
      "pending",
    );
    assert.equal(JSON.parse(files.get(sourcesPath) || "{}").status, "pending");
    assert.equal(files.get(backgroundPath), background);
    assert.equal(context.background, background);
  } finally {
    (globalThis as any).IOUtils = previousIO;
  }
});

function validCoreBackground(): string {
  return [
    "## 论文依据",
    "### 所属领域",
    "EDA",
    "### 研究问题",
    "Delay",
    "### 工作流",
    "Characterization",
    "### 方法组件",
    "HGAT",
    "### 实验与评价语境",
    "rRMSE",
  ].join("\n");
}

test("validates the persisted minimum knowledge instead of file markers", () => {
  const background = [
    "## 论文依据",
    "",
    "### 所属领域",
    "EDA",
    "### 研究问题",
    "Delay variation",
    "### 工作流",
    "Library characterization",
    "### 方法组件",
    "HGAT",
    "### 实验与评价语境",
    "rRMSE",
  ].join("\n");
  assert.doesNotThrow(() => validateCoreBackgroundMarkdown(background));
  assert.throws(
    () =>
      validateCoreBackgroundMarkdown(
        background.replace("Library characterization", ""),
      ),
    /工作流/,
  );

  const paperMarkdown = Array.from(
    { length: 6 },
    (_, index) => `term-${index + 1}`,
  ).join(" ");
  const rows = Array.from({ length: 6 }, (_, index) => {
    const term = `term-${index + 1}`;
    return `| ${term} | ${term} | 术语${index + 1} | domain | definition | Paper; chars ${index}-${index + 1} | paper | high | 2026-07-17T00:00:00.000Z |`;
  });
  const terminology = [
    "| Observed expression | Canonical English | Preferred Chinese | Category | Definition | Paper evidence | Source level | Confidence | Updated at |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
  assert.equal(countTerminologyEntries(terminology, paperMarkdown), 6);
  assert.throws(
    () => countTerminologyEntries(terminology, paperMarkdown.toUpperCase()),
    /absent from validated Markdown/,
  );
  assert.throws(
    () =>
      countTerminologyEntries(
        terminology.replace("| paper | high |", "| paper | |"),
        paperMarkdown,
      ),
    /incomplete table row/,
  );
});
