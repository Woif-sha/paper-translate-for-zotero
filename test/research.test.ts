import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildPaperIndex } from "../src/context/paperContext";
import { buildCoreKnowledgePrompt } from "../src/context/prompts";
import {
  assertMinimumCoreKnowledge,
  beginKnowledgeOperationsSession,
  cancelActiveKnowledgeOperations,
  continuePaperLearning,
  endKnowledgeOperationsSession,
  ensureCorePaperKnowledge,
  ensureExternalKnowledgeResearch,
  parseCoreKnowledgeResult,
  parseResearchResult,
  runBoundedKnowledgeOperation,
  startPaperLearningRetry,
  stopPaperLearning,
  validatePaperTerminology,
} from "../src/context/research";
import {
  beginPreparationAttempt,
  createPreparationRecord,
  getPreparationRetryScope,
  updatePreparationStages,
} from "../src/context/runtime";

test("parses tiered background research JSON", () => {
  const result = parseResearchResult(
    JSON.stringify({
      summary: "用于消歧的通用背景。",
      sources: [
        {
          title: "Official standard",
          url: "https://example.org/standard",
          snippet: "Normative definition",
          sourceLevel: "official",
          purpose: "确认规范术语",
        },
      ],
    }),
  );
  assert.equal(result.sources[0].sourceLevel, "official");
});

test("rejects markdown fences instead of silently recovering JSON", () => {
  assert.throws(
    () => parseResearchResult('```json\n{"summary":"x","sources":[]}\n```'),
    /invalid JSON/,
  );
});

test("rejects non-HTTPS external sources", () => {
  assert.throws(
    () =>
      parseResearchResult(
        JSON.stringify({
          summary: "background",
          sources: [
            {
              title: "Insecure source",
              url: "http://example.org/source",
              snippet: "text",
              sourceLevel: "community",
              purpose: "explanation",
            },
          ],
        }),
      ),
    /must use HTTPS/,
  );
});

test("rejects uncited model-memory background without sources", () => {
  assert.throws(
    () =>
      parseResearchResult(
        JSON.stringify({ summary: "unverified claim", sources: [] }),
      ),
    /without sources/,
  );
  assert.deepEqual(
    parseResearchResult(JSON.stringify({ summary: "", sources: [] })),
    { summary: "", sources: [] },
  );
});

test("accepts the paper typo but records its canonical aggregation term", () => {
  const markdown =
    "# Method\nThe Node level aggression module performs graph updates.";
  const index = buildPaperIndex({
    parentItemKey: "ABCD1234",
    fullMdSha256: "abc",
    manifestSha256: "manifest",
    markdown,
    manifest: { noSections: true, totalChars: markdown.length },
  });
  const entries = validatePaperTerminology(
    [
      {
        observed: "Node level aggression",
        canonical: "node-level aggregation",
        translation: "节点级聚合",
        category: "graph operation",
        definition: "Aggregates neighboring node features.",
      },
    ],
    { markdown, index } as any,
  );
  assert.equal(entries[0].canonical, "node-level aggregation");
  assert.match(entries[0].evidence, /Method; chars/);
  assert.equal(
    validatePaperTerminology([{ ...entries[0], observed: "invented term" }], {
      markdown,
      index,
    } as any).length,
    0,
  );
  assert.equal(
    validatePaperTerminology([{ ...entries[0], observed: "hgat" }], {
      markdown: `${markdown} HGAT`,
      index,
    } as any).length,
    0,
  );
});

test("parses complete core knowledge and rejects missing stages", () => {
  const value = {
    field: "EDA",
    problem: "delay variation",
    workflow: "characterization",
    method: "HGAT",
    evaluation: "rRMSE",
    translationRisks: ["cell means standard cell"],
    openQuestions: ["Liberty variance format"],
    searchQueries: ["Liberty LVF official"],
    terms: [
      {
        observed: "HGAT",
        canonical: "heterogeneous graph attention network",
        translation: "异构图注意力网络",
        category: "model",
        definition: "graph model",
      },
    ],
  };
  assert.equal(parseCoreKnowledgeResult(JSON.stringify(value)).terms.length, 1);
  assert.throws(
    () =>
      parseCoreKnowledgeResult(JSON.stringify({ ...value, method: undefined })),
    /method/,
  );
});

test("caps one knowledge pass at 12 terms, 3 questions, and 3 sources", () => {
  const terms = Array.from({ length: 15 }, (_, index) => ({
    observed: `term-${index}`,
    canonical: `term-${index}`,
    translation: `术语-${index}`,
    category: "domain",
    definition: `definition-${index}`,
  }));
  const core = parseCoreKnowledgeResult(
    JSON.stringify({
      field: "EDA",
      problem: "timing variation",
      workflow: "characterization",
      method: "HGAT",
      evaluation: "rRMSE",
      translationRisks: [],
      openQuestions: [],
      searchQueries: Array.from(
        { length: 5 },
        (_, index) => `question-${index}`,
      ),
      terms,
    }),
  );
  assert.equal(core.terms.length, 12);
  assert.equal(core.searchQueries.length, 3);

  const external = parseResearchResult(
    JSON.stringify({
      summary: "bounded external background",
      sources: Array.from({ length: 5 }, (_, index) => ({
        title: `source-${index}`,
        url: `https://example.org/${index}`,
        snippet: `snippet-${index}`,
        sourceLevel: "official",
        purpose: "terminology",
      })),
    }),
  );
  assert.equal(external.sources.length, 3);
});

test("shares one terminal core decision and never starts a model request", async () => {
  const previousIO = (globalThis as any).IOUtils;
  const paperDir = "E:\\ZoteroData\\paper-translate-for-zotero\\ABCD1234";
  const preparationPath = `${paperDir}\\_preparation.json`;
  let record = createPreparationRecord("ABCD1234", "hash");
  record = updatePreparationStages(record, [
    { id: "source", status: "complete" },
    { id: "index", status: "complete" },
    { id: "background", status: "complete" },
    { id: "terminology", status: "complete" },
  ]);
  let releaseFirstRead!: () => void;
  const firstRead = new Promise<void>((resolve) => {
    releaseFirstRead = resolve;
  });
  let reads = 0;
  (globalThis as any).IOUtils = {
    async exists(path: string) {
      return path === preparationPath;
    },
    async read(path: string) {
      assert.equal(path, preparationPath);
      reads += 1;
      if (reads === 1) await firstRead;
      return new TextEncoder().encode(JSON.stringify(record));
    },
  };
  const context = {
    paperDir,
    fullMdSha256: "hash",
    identity: {
      libraryID: 1,
      parentItemKey: "ABCD1234",
      attachmentID: 42,
    },
  } as any;
  beginKnowledgeOperationsSession();
  try {
    const first = ensureCorePaperKnowledge(context);
    const second = ensureCorePaperKnowledge(context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reads, 1);
    releaseFirstRead();
    await Promise.all([first, second]);
    assert.equal(reads, 1);
    await ensureCorePaperKnowledge(context);
    assert.equal(reads, 2);
  } finally {
    endKnowledgeOperationsSession();
    (globalThis as any).IOUtils = previousIO;
  }
});

test("stops a partially persisted core pass instead of retrying it", async () => {
  const previousIO = (globalThis as any).IOUtils;
  const paperDir = "E:\\ZoteroData\\paper-translate-for-zotero\\ABCD1234";
  const preparationPath = `${paperDir}\\_preparation.json`;
  const sourcePath = `${paperDir}\\_paper_source.json`;
  const mineruCacheDir = "E:\\ZoteroData\\llm-for-zotero-mineru\\42";
  const fullMdPath = `${mineruCacheDir}\\full.md`;
  const markdown = "# Paper\nValidated Markdown";
  const fullMdSha256 = createHash("sha256").update(markdown).digest("hex");
  let record = createPreparationRecord("ABCD1234", fullMdSha256);
  record = updatePreparationStages(record, [
    { id: "source", status: "complete" },
    { id: "index", status: "complete" },
    { id: "background", status: "complete" },
  ]);
  const files = new Map<string, string>([
    [preparationPath, JSON.stringify(record)],
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
  beginKnowledgeOperationsSession();
  try {
    await ensureCorePaperKnowledge(context);
    const stopped = JSON.parse(files.get(preparationPath) || "{}");
    assert.equal(
      stopped.stages.find((stage: { id: string }) => stage.id === "terminology")
        .status,
      "error",
    );
    assert.equal(
      stopped.stages.find((stage: { id: string }) => stage.id === "external")
        .status,
      "skipped",
    );
    await ensureCorePaperKnowledge(context);
    assert.equal(
      files.get(preparationPath),
      JSON.stringify(stopped, null, 2) + "\n",
    );
  } finally {
    endKnowledgeOperationsSession();
    (globalThis as any).IOUtils = previousIO;
  }
});

test("closes downstream stages after a terminal core warning", async () => {
  const previousIO = (globalThis as any).IOUtils;
  const paperDir = "E:\\ZoteroData\\paper-translate-for-zotero\\ABCD1234";
  const preparationPath = `${paperDir}\\_preparation.json`;
  const sourcePath = `${paperDir}\\_paper_source.json`;
  const mineruCacheDir = "E:\\ZoteroData\\llm-for-zotero-mineru\\42";
  const fullMdPath = `${mineruCacheDir}\\full.md`;
  const markdown = "# Paper\nValidated Markdown";
  const fullMdSha256 = createHash("sha256").update(markdown).digest("hex");
  let record = createPreparationRecord("ABCD1234", fullMdSha256);
  record = updatePreparationStages(record, [
    { id: "source", status: "complete" },
    { id: "index", status: "complete" },
    { id: "background", status: "warning", detail: "minimum pass stopped" },
  ]);
  const files = new Map<string, string>([
    [preparationPath, JSON.stringify(record)],
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
  beginKnowledgeOperationsSession();
  try {
    await ensureCorePaperKnowledge(context);
    const stopped = JSON.parse(files.get(preparationPath) || "{}");
    assert.equal(
      stopped.stages.find((stage: { id: string }) => stage.id === "background")
        .status,
      "warning",
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
    endKnowledgeOperationsSession();
    (globalThis as any).IOUtils = previousIO;
  }
});

test("closes a stale external stage even when its source record is damaged", async () => {
  const previousIO = (globalThis as any).IOUtils;
  const paperDir = "E:\\ZoteroData\\paper-translate-for-zotero\\ABCD1234";
  const preparationPath = `${paperDir}\\_preparation.json`;
  const sourcePath = `${paperDir}\\_paper_source.json`;
  const backgroundPath = `${paperDir}\\background.md`;
  const sourcesPath = `${paperDir}\\background-sources.json`;
  const mineruCacheDir = "E:\\ZoteroData\\llm-for-zotero-mineru\\42";
  const fullMdPath = `${mineruCacheDir}\\full.md`;
  const markdown = "# Paper\nValidated Markdown";
  const fullMdSha256 = createHash("sha256").update(markdown).digest("hex");
  let record = createPreparationRecord("ABCD1234", fullMdSha256);
  record = updatePreparationStages(record, [
    { id: "source", status: "complete" },
    { id: "index", status: "complete" },
    { id: "background", status: "complete" },
    { id: "terminology", status: "complete" },
    { id: "external", status: "running" },
  ]);
  const background = [
    "# Background: Paper",
    "",
    "## 论文依据",
    "",
    "### 所属领域",
    "EDA",
    "### 研究问题",
    "Timing variation",
    "### 工作流",
    "Library characterization",
    "### 方法组件",
    "HGAT",
    "### 实验与评价语境",
    "rRMSE",
    "### 外部检索问题",
    "",
    "- timing arc official definition",
    "",
  ].join("\n");
  const files = new Map<string, string>([
    [preparationPath, JSON.stringify(record)],
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
    [backgroundPath, background],
    [sourcesPath, "{damaged"],
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
  beginKnowledgeOperationsSession();
  try {
    await assert.rejects(
      ensureExternalKnowledgeResearch(context),
      /Unexpected token|not valid JSON|JSON/,
    );
    const stopped = JSON.parse(files.get(preparationPath) || "{}");
    assert.equal(
      stopped.stages.find((stage: { id: string }) => stage.id === "external")
        .status,
      "error",
    );
    assert.equal(files.get(sourcesPath), "{damaged");
  } finally {
    endKnowledgeOperationsSession();
    (globalThis as any).IOUtils = previousIO;
  }
});

test("reloads persisted search questions instead of using a stale caller snapshot", async () => {
  const previousIO = (globalThis as any).IOUtils;
  const paperDir = "E:\\ZoteroData\\paper-translate-for-zotero\\ABCD1234";
  const preparationPath = `${paperDir}\\_preparation.json`;
  const sourcePath = `${paperDir}\\_paper_source.json`;
  const backgroundPath = `${paperDir}\\background.md`;
  const sourcesPath = `${paperDir}\\background-sources.json`;
  const mineruCacheDir = "E:\\ZoteroData\\llm-for-zotero-mineru\\42";
  const fullMdPath = `${mineruCacheDir}\\full.md`;
  const markdown = "# Paper\nValidated Markdown";
  const fullMdSha256 = createHash("sha256").update(markdown).digest("hex");
  let record = createPreparationRecord("ABCD1234", fullMdSha256);
  record = updatePreparationStages(record, [
    { id: "source", status: "complete" },
    { id: "index", status: "complete" },
    { id: "background", status: "complete" },
    { id: "terminology", status: "complete" },
    { id: "external", status: "running" },
  ]);
  const background = [
    "# Background: Paper",
    "",
    "## 论文依据",
    "",
    "### 所属领域",
    "EDA",
    "### 研究问题",
    "Timing variation",
    "### 工作流",
    "Library characterization",
    "### 方法组件",
    "HGAT",
    "### 实验与评价语境",
    "rRMSE",
    "### 外部检索问题",
    "",
    "- timing arc official definition",
    "",
  ].join("\n");
  const pendingResearch = {
    schemaVersion: 3,
    parentItemKey: "ABCD1234",
    fullMdSha256,
    status: "pending",
    queries: [],
    sources: [],
    failures: [],
  };
  const files = new Map<string, string>([
    [preparationPath, JSON.stringify(record)],
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
    [backgroundPath, background],
    [sourcesPath, JSON.stringify(pendingResearch)],
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
  const staleContext = {
    paperDir,
    mineruCacheDir,
    fullMdPath,
    fullMdSha256,
    background: "",
    identity: {
      libraryID: 1,
      parentItemKey: "ABCD1234",
      attachmentID: 42,
      attachmentKey: "WXYZ5678",
    },
  } as any;
  beginKnowledgeOperationsSession();
  try {
    await ensureExternalKnowledgeResearch(staleContext);
    const persisted = JSON.parse(files.get(sourcesPath) || "{}");
    assert.deepEqual(persisted.queries, ["timing arc official definition"]);
    assert.equal(persisted.status, "warning");
    assert.equal(staleContext.background, background);
    const stopped = JSON.parse(files.get(preparationPath) || "{}");
    assert.equal(
      stopped.stages.find((stage: { id: string }) => stage.id === "external")
        .status,
      "warning",
    );
  } finally {
    endKnowledgeOperationsSession();
    (globalThis as any).IOUtils = previousIO;
  }
});

test("enforces the minimum evidence threshold and cancels a hung request", async () => {
  assert.throws(
    () =>
      assertMinimumCoreKnowledge(Array.from({ length: 5 }, () => ({}) as any)),
    /at least 6/,
  );
  let aborted = false;
  await assert.rejects(
    runBoundedKnowledgeOperation({
      label: "test knowledge",
      maxDurationMs: 15,
      operation: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    }),
    /1 秒内未结束，已取消/,
  );
  assert.equal(aborted, true);
});

test("cancels active knowledge work during shutdown", async () => {
  let aborted = false;
  const running = runBoundedKnowledgeOperation({
    label: "shutdown knowledge",
    maxDurationMs: 10_000,
    operation: (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  });
  cancelActiveKnowledgeOperations();
  await assert.rejects(running, /论文知识准备已取消/);
  assert.equal(aborted, true);
});

test("stops only the selected paper across Markdown hash versions", async () => {
  const previousIO = (globalThis as any).IOUtils;
  const paperDir = "E:\\ZoteroData\\paper-translate-for-zotero\\ABCD1234";
  const preparationPath = `${paperDir}\\_preparation.json`;
  const preparation = updatePreparationStages(
    createPreparationRecord("ABCD1234", "hash-a"),
    [
      { id: "source", status: "complete" },
      { id: "index", status: "complete" },
      { id: "background", status: "complete" },
      { id: "terminology", status: "complete" },
      { id: "external", status: "complete" },
    ],
  );
  (globalThis as any).IOUtils = {
    async exists(path: string) {
      return path === preparationPath;
    },
    async read(path: string) {
      assert.equal(path, preparationPath);
      return new TextEncoder().encode(JSON.stringify(preparation));
    },
  };
  const firstContext = {
    paperDir,
    identity: { libraryID: 1, parentItemKey: "ABCD1234" },
    fullMdSha256: "hash-a",
  } as any;
  let finishSecond!: () => void;
  const first = runBoundedKnowledgeOperation({
    label: "first paper",
    maxDurationMs: 1_000,
    operationKey: "1:ABCD1234:old-hash:1",
    operation: () => new Promise(() => {}),
  });
  const second = runBoundedKnowledgeOperation({
    label: "second paper",
    maxDurationMs: 1_000,
    operationKey: "1:EFGH5678:hash-b:1",
    operation: () =>
      new Promise<string>((resolve) => {
        finishSecond = () => resolve("done");
      }),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const firstStopped = assert.rejects(first, /用户已停止/);
  try {
    await stopPaperLearning(firstContext);
    await firstStopped;
    finishSecond();
    assert.equal(await second, "done");
  } finally {
    (globalThis as any).IOUtils = previousIO;
  }
});

test("closes an unowned running stage when the user stops it", async () => {
  const previousIO = (globalThis as any).IOUtils;
  const paperDir = "E:\\ZoteroData\\paper-translate-for-zotero\\ABCD1234";
  const mineruCacheDir = "E:\\ZoteroData\\llm-for-zotero-mineru\\42";
  const fullMdPath = `${mineruCacheDir}\\full.md`;
  const sourcePath = `${paperDir}\\_paper_source.json`;
  const preparationPath = `${paperDir}\\_preparation.json`;
  const markdown = "# Paper\nValidated Markdown";
  const fullMdSha256 = createHash("sha256").update(markdown).digest("hex");
  let preparation = createPreparationRecord("ABCD1234", fullMdSha256);
  preparation = updatePreparationStages(preparation, [
    { id: "source", status: "complete" },
    { id: "index", status: "complete" },
    { id: "background", status: "running" },
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
        mineruCacheDir,
        fullMdPath,
        fullMdSha256,
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
    await stopPaperLearning(context);
    const stopped = JSON.parse(files.get(preparationPath) || "{}");
    const background = stopped.stages.find(
      (stage: { id: string }) => stage.id === "background",
    );
    assert.equal(background.status, "error");
    assert.equal(background.failureKind, "user-stopped");
    assert.equal(
      stopped.stages.find((stage: { id: string }) => stage.id === "terminology")
        .status,
      "skipped",
    );
  } finally {
    (globalThis as any).IOUtils = previousIO;
  }
});

test("closes a persisted retry attempt that lost its in-memory owner", async () => {
  const previousIO = (globalThis as any).IOUtils;
  const paperDir = "E:\\ZoteroData\\paper-translate-for-zotero\\ABCD1234";
  const mineruCacheDir = "E:\\ZoteroData\\llm-for-zotero-mineru\\42";
  const fullMdPath = `${mineruCacheDir}\\full.md`;
  const sourcePath = `${paperDir}\\_paper_source.json`;
  const preparationPath = `${paperDir}\\_preparation.json`;
  const markdown = "# Paper\nValidated Markdown";
  const fullMdSha256 = createHash("sha256").update(markdown).digest("hex");
  let preparation = createPreparationRecord("ABCD1234", fullMdSha256);
  preparation = updatePreparationStages(preparation, [
    { id: "source", status: "complete" },
    { id: "index", status: "complete" },
    {
      id: "background",
      status: "error",
      detail: "quota exhausted",
      failureKind: "request",
    },
    { id: "terminology", status: "skipped" },
    { id: "external", status: "skipped" },
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
        mineruCacheDir,
        fullMdPath,
        fullMdSha256,
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
    const pendingRetry = await beginPreparationAttempt(context, "core");
    assert.equal(pendingRetry.attemptId, 2);
    assert.equal(pendingRetry.stages[2].status, "pending");

    beginKnowledgeOperationsSession();
    await ensureCorePaperKnowledge(context);

    const stopped = JSON.parse(files.get(preparationPath) || "{}");
    const background = stopped.stages.find(
      (stage: { id: string }) => stage.id === "background",
    );
    assert.equal(background.status, "error");
    assert.equal(background.failureKind, "interrupted");
    assert.equal(getPreparationRetryScope(stopped), "core");
  } finally {
    endKnowledgeOperationsSession();
    (globalThis as any).IOUtils = previousIO;
  }
});

test("keeps the retry handoff gated until the new attempt job is registered", async () => {
  const previousIO = (globalThis as any).IOUtils;
  const paperDir = "E:\\ZoteroData\\paper-translate-for-zotero\\ABCD1234";
  const mineruCacheDir = "E:\\ZoteroData\\llm-for-zotero-mineru\\42";
  const fullMdPath = `${mineruCacheDir}\\full.md`;
  const sourcePath = `${paperDir}\\_paper_source.json`;
  const preparationPath = `${paperDir}\\_preparation.json`;
  const backgroundPath = `${paperDir}\\background.md`;
  const sourcesPath = `${paperDir}\\background-sources.json`;
  const markdown = "# Paper\nValidated Markdown";
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
      detail: "quota exhausted",
      failureKind: "request",
    },
  ]);
  const background = [
    "# Background: Paper",
    "",
    "## 论文依据",
    "",
    "### 所属领域",
    "EDA",
    "### 研究问题",
    "Timing variation",
    "### 工作流",
    "Library characterization",
    "### 方法组件",
    "HGAT",
    "### 实验与评价语境",
    "rRMSE",
    "### 外部检索问题",
    "- 无",
    "",
  ].join("\n");
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
    [
      sourcesPath,
      JSON.stringify({
        schemaVersion: 3,
        parentItemKey: "ABCD1234",
        fullMdSha256,
        status: "warning",
        researchedAt: new Date().toISOString(),
        queries: [],
        sources: [],
        failures: [{ provider: "web-search", message: "quota exhausted" }],
      }),
    ],
  ]);
  let releaseReset!: () => void;
  const resetPaused = new Promise<void>((resolve) => {
    releaseReset = resolve;
  });
  let notifyResetStarted!: () => void;
  const resetStarted = new Promise<void>((resolve) => {
    notifyResetStarted = resolve;
  });
  let pauseSourcesWrite = true;
  let reads = 0;
  (globalThis as any).IOUtils = {
    async exists(path: string) {
      return files.has(path);
    },
    async read(path: string) {
      reads += 1;
      return new TextEncoder().encode(files.get(path) || "");
    },
    async write(path: string, data: Uint8Array) {
      if (path === sourcesPath && pauseSourcesWrite) {
        pauseSourcesWrite = false;
        notifyResetStarted();
        await resetPaused;
      }
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
      title: "Paper",
    },
  } as any;
  beginKnowledgeOperationsSession();
  try {
    const retry = startPaperLearningRetry(context, "external");
    await resetStarted;
    const readsBeforeCompetingRefresh = reads;
    await continuePaperLearning(context);
    assert.equal(reads, readsBeforeCompetingRefresh);
    releaseReset();

    const { attemptId, learning } = await retry;
    assert.equal(attemptId, 2);
    await learning;
    const completed = JSON.parse(files.get(preparationPath) || "{}");
    assert.equal(completed.attemptId, 2);
    assert.equal(
      completed.stages.find((stage: { id: string }) => stage.id === "external")
        .status,
      "skipped",
    );
  } finally {
    releaseReset?.();
    endKnowledgeOperationsSession();
    (globalThis as any).IOUtils = previousIO;
  }
});

test("stops a paper between core completion and external registration", async () => {
  const previousIO = (globalThis as any).IOUtils;
  const paperDir = "E:\\ZoteroData\\paper-translate-for-zotero\\ABCD1234";
  const mineruCacheDir = "E:\\ZoteroData\\llm-for-zotero-mineru\\42";
  const fullMdPath = `${mineruCacheDir}\\full.md`;
  const sourcePath = `${paperDir}\\_paper_source.json`;
  const preparationPath = `${paperDir}\\_preparation.json`;
  const markdown = "# Paper\nValidated Markdown";
  const fullMdSha256 = createHash("sha256").update(markdown).digest("hex");
  let preparation = createPreparationRecord("ABCD1234", fullMdSha256);
  preparation = updatePreparationStages(preparation, [
    { id: "source", status: "complete" },
    { id: "index", status: "complete" },
    { id: "background", status: "complete" },
    { id: "terminology", status: "complete" },
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
        mineruCacheDir,
        fullMdPath,
        fullMdSha256,
      }),
    ],
    [preparationPath, JSON.stringify(preparation)],
    [fullMdPath, markdown],
  ]);
  let preparationReads = 0;
  let notifyGapReached!: () => void;
  const gapReached = new Promise<void>((resolve) => {
    notifyGapReached = resolve;
  });
  let releaseGap!: () => void;
  const gapRelease = new Promise<void>((resolve) => {
    releaseGap = resolve;
  });
  (globalThis as any).IOUtils = {
    async exists(path: string) {
      return files.has(path);
    },
    async read(path: string) {
      if (path === preparationPath) {
        preparationReads += 1;
        if (preparationReads === 2) {
          notifyGapReached();
          await gapRelease;
        }
      }
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
  beginKnowledgeOperationsSession();
  try {
    const learning = continuePaperLearning(context);
    await gapReached;
    await stopPaperLearning(context);
    releaseGap();
    await learning;

    const stopped = JSON.parse(files.get(preparationPath) || "{}");
    const external = stopped.stages.find(
      (stage: { id: string }) => stage.id === "external",
    );
    assert.equal(external.status, "error");
    assert.equal(external.failureKind, "user-stopped");
  } finally {
    releaseGap?.();
    endKnowledgeOperationsSession();
    (globalThis as any).IOUtils = previousIO;
  }
});

test("requests the sample EDA terminology and canonical typo mapping", () => {
  const markdown =
    "# Method\nNode level aggression is used by HGAT for a timing arc and 3σ percentile.";
  const index = buildPaperIndex({
    parentItemKey: "ABCD1234",
    fullMdSha256: "abc",
    manifestSha256: "manifest",
    markdown,
    manifest: { noSections: true, totalChars: markdown.length },
  });
  const prompt = buildCoreKnowledgePrompt({
    markdown,
    index,
    identity: { title: "EDA paper", doi: "" },
  } as any);
  assert.match(prompt, /standard cell.*library characterization.*timing arc/);
  assert.match(
    prompt,
    /Node level aggression.*node-level aggregation.*节点级聚合/,
  );
});
