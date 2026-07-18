import {
  PAPER_CONTEXT_SCHEMA_VERSION,
  PaperIdentity,
  PaperIndex,
  PaperSourceRecord,
  alignSelectionHyphens,
  buildPaperIndex,
  createBackgroundMarkdown,
  createTerminologyMarkdown,
  parseAndValidateManifest,
  parseAndValidateProvenance,
  retrievePassages,
} from "./paperContext";

const MINERU_ROOT_NAME = "llm-for-zotero-mineru";
const CONTEXT_ROOT_NAME = "paper-translate-for-zotero";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

type IOUtilsLike = {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<Uint8Array | ArrayBuffer>;
  write(
    path: string,
    data: Uint8Array,
    options?: { tmpPath?: string },
  ): Promise<unknown>;
  makeDirectory(
    path: string,
    options?: { createAncestors?: boolean; ignoreExisting?: boolean },
  ): Promise<void>;
  getChildren(path: string): Promise<string[]>;
  remove(
    path: string,
    options?: { recursive?: boolean; ignoreAbsent?: boolean },
  ): Promise<void>;
};

export type ValidatedPaperContext = {
  identity: PaperIdentity;
  mineruCacheDir: string;
  fullMdPath: string;
  markdown: string;
  fullMdSha256: string;
  paperDir: string;
  index: PaperIndex;
  terminology: string;
  background: string;
  passages: ReturnType<typeof retrievePassages>;
  alignedQuery?: string;
};

export type BackgroundSource = {
  title: string;
  url: string;
  snippet: string;
  sourceLevel: "official" | "academic" | "community";
  purpose: string;
};

export type TerminologyEntry = {
  observed: string;
  canonical: string;
  translation: string;
  category: string;
  definition: string;
  evidence: string;
  sourceLevel: "paper" | "official" | "academic" | "community";
  confidence: "high" | "medium" | "low";
};

export type PreparationStageId =
  | "source"
  | "index"
  | "background"
  | "terminology"
  | "external";

export type PreparationStageStatus =
  | "pending"
  | "running"
  | "complete"
  | "warning"
  | "error"
  | "skipped";

export type PreparationRecord = {
  schemaVersion: typeof PAPER_CONTEXT_SCHEMA_VERSION;
  parentItemKey: string;
  fullMdSha256: string;
  overall: "preparing" | "core-ready" | "ready" | "error";
  stages: Array<{
    id: PreparationStageId;
    file: string;
    required: boolean;
    status: PreparationStageStatus;
    startedAt?: string;
    completedAt?: string;
    detail?: string;
  }>;
  integrityIssues?: Array<{
    stage: "background" | "terminology" | "external";
    detail: string;
    detectedAt: string;
  }>;
  updatedAt: string;
};

export type BackgroundResearchRecord = {
  schemaVersion: typeof PAPER_CONTEXT_SCHEMA_VERSION;
  parentItemKey: string;
  fullMdSha256: string;
  status: "pending" | "complete" | "empty" | "warning";
  researchedAt?: string;
  summarySha256?: string;
  queries: string[];
  sources: BackgroundSource[];
  failures?: Array<{ provider: string; message: string }>;
};

const PREPARATION_STAGE_FILES: Record<PreparationStageId, string> = {
  source: "_paper_source.json",
  index: "index.json",
  background: "background.md",
  terminology: "terminology.md",
  external: "background-sources.json",
};
const TERMINAL_PREPARATION_STATUSES = new Set<PreparationStageStatus>([
  "complete",
  "warning",
  "error",
  "skipped",
]);
export const MINIMUM_TERMINOLOGY_ENTRIES = 6;
export const MAXIMUM_TERMINOLOGY_ENTRIES = 12;
const paperFileWrites = new Map<string, Promise<void>>();

export async function preparePaperContext(
  attachmentItemID: number,
  query: string,
): Promise<ValidatedPaperContext> {
  const io = getIOUtils();
  const identity = resolvePaperIdentity(attachmentItemID);
  const dataDir = resolveZoteroDataDir();
  const mineruCacheDir = joinPath(
    dataDir,
    MINERU_ROOT_NAME,
    String(identity.attachmentID),
  );
  const provenancePath = joinPath(mineruCacheDir, "_llm_source.json");
  const fullMdPath = joinPath(mineruCacheDir, "full.md");
  const manifestPath = joinPath(mineruCacheDir, "manifest.json");

  const [provenanceRaw, markdown, manifestRaw] = await Promise.all([
    readRequiredText(io, provenancePath),
    readRequiredText(io, fullMdPath),
    readRequiredText(io, manifestPath),
  ]);
  if (!markdown.trim())
    throw new Error(`MinerU full.md is empty: ${fullMdPath}`);
  parseAndValidateProvenance(provenanceRaw, identity);
  const manifest = parseAndValidateManifest(manifestRaw, markdown);
  const [fullMdSha256, manifestSha256] = await Promise.all([
    sha256(markdown),
    sha256(manifestRaw),
  ]);

  const contextRoot = joinPath(dataDir, CONTEXT_ROOT_NAME);
  const paperDir = resolvePaperDirectory(contextRoot, identity.parentItemKey);
  const sourceRecord: PaperSourceRecord = {
    schemaVersion: PAPER_CONTEXT_SCHEMA_VERSION,
    ...identity,
    mineruCacheDir,
    fullMdPath,
    fullMdSha256,
    updatedAt: new Date().toISOString(),
  };
  const alignedQuery = alignSelectionHyphens(query.trim(), markdown);
  const { index, terminology, background } = await withPaperFileLock(
    paperDir,
    async () => {
      const currentIdentity = resolvePaperIdentity(attachmentItemID);
      if (
        currentIdentity.libraryID !== identity.libraryID ||
        currentIdentity.parentItemKey !== identity.parentItemKey ||
        currentIdentity.attachmentID !== identity.attachmentID ||
        currentIdentity.attachmentKey !== identity.attachmentKey
      ) {
        throw new Error(
          "Zotero paper identity changed during paper context preparation",
        );
      }
      const [currentProvenance, currentMarkdown, currentManifest] =
        await Promise.all([
          readRequiredText(io, provenancePath),
          readRequiredText(io, fullMdPath),
          readRequiredText(io, manifestPath),
        ]);
      if (
        currentProvenance !== provenanceRaw ||
        currentMarkdown !== markdown ||
        currentManifest !== manifestRaw
      ) {
        throw new Error(
          "MinerU Markdown, provenance, or manifest changed during paper context preparation",
        );
      }
      await io.makeDirectory(paperDir, {
        createAncestors: true,
        ignoreExisting: true,
      });
      const previousSource = await validateExistingPaperSource(
        io,
        paperDir,
        sourceRecord,
      );
      const contentChanged =
        Boolean(previousSource?.fullMdSha256) &&
        previousSource?.fullMdSha256 !== fullMdSha256;
      const schemaChanged =
        Boolean(previousSource) &&
        previousSource?.schemaVersion !== PAPER_CONTEXT_SCHEMA_VERSION;
      const sourcePath = joinPath(paperDir, "_paper_source.json");
      const indexPath = joinPath(paperDir, "index.json");
      const terminologyPath = joinPath(paperDir, "terminology.md");
      const backgroundPath = joinPath(paperDir, "background.md");
      const backgroundSourcesPath = joinPath(
        paperDir,
        "background-sources.json",
      );
      const preparationPath = joinPath(paperDir, "_preparation.json");

      if (!previousSource) await writeJson(io, sourcePath, sourceRecord);
      let paperIndex = await readJsonIfExists<PaperIndex>(io, indexPath);
      const rebuiltIndex = buildPaperIndex({
        parentItemKey: identity.parentItemKey,
        fullMdSha256,
        manifestSha256,
        markdown,
        manifest,
      });
      if (!paperIndexMatches(paperIndex, rebuiltIndex)) {
        paperIndex = rebuiltIndex;
        await writeJson(io, indexPath, paperIndex);
      }

      if (contentChanged || schemaChanged) {
        const previousTerminology = (await io.exists(terminologyPath))
          ? await readRequiredText(io, terminologyPath)
          : "";
        await writeText(
          io,
          terminologyPath,
          previousTerminology
            ? migrateTerminologyMarkdown(
                previousTerminology,
                identity.title,
                markdown,
              )
            : createTerminologyMarkdown(identity.title),
        );
        await writeText(
          io,
          backgroundPath,
          createBackgroundMarkdown(identity.title),
        );
        await writeJson(
          io,
          backgroundSourcesPath,
          createBackgroundResearchRecord(identity.parentItemKey, fullMdSha256),
        );
        await writeJson(
          io,
          preparationPath,
          createPreparationRecord(identity.parentItemKey, fullMdSha256),
        );
      }

      await ensureTextFile(
        io,
        terminologyPath,
        createTerminologyMarkdown(identity.title),
      );
      await ensureTextFile(
        io,
        backgroundPath,
        createBackgroundMarkdown(identity.title),
      );
      await ensureJsonFile(
        io,
        backgroundSourcesPath,
        createBackgroundResearchRecord(identity.parentItemKey, fullMdSha256),
      );
      await ensureJsonFile(
        io,
        preparationPath,
        createPreparationRecord(identity.parentItemKey, fullMdSha256),
      );
      if (previousSource) await writeJson(io, sourcePath, sourceRecord);

      let preparation = await readPreparationRecordFromPath(
        io,
        preparationPath,
        identity.parentItemKey,
        fullMdSha256,
      );
      preparation = updatePreparationStages(preparation, [
        { id: "source", status: "complete" },
        { id: "index", status: "complete" },
      ]);
      const recovered = await recoverOptionalKnowledge({
        preparation,
        parentItemKey: identity.parentItemKey,
        fullMdSha256,
        paperMarkdown: markdown,
        background: await readRequiredText(io, backgroundPath),
        terminology: await readRequiredText(io, terminologyPath),
        backgroundSources: await readRequiredText(io, backgroundSourcesPath),
      });
      preparation = recovered.preparation;
      await writePreparationRecord(io, preparationPath, preparation);
      return {
        index: paperIndex,
        terminology: recovered.terminology,
        background: recovered.background,
      };
    },
  );
  return {
    identity,
    mineruCacheDir,
    fullMdPath,
    markdown,
    fullMdSha256,
    paperDir,
    index,
    terminology,
    background,
    alignedQuery,
    passages: retrievePassages(
      markdown,
      index,
      alignedQuery || `${identity.title} ${identity.doi}`.trim(),
    ),
  };
}

const EXTERNAL_BACKGROUND_MARKER = "## 外部背景补充";

async function recoverOptionalKnowledge(params: {
  preparation: PreparationRecord;
  parentItemKey: string;
  fullMdSha256: string;
  paperMarkdown: string;
  background: string;
  terminology: string;
  backgroundSources: string;
}): Promise<{
  preparation: PreparationRecord;
  background: string;
  terminology: string;
}> {
  let preparation = params.preparation;
  const issues: NonNullable<PreparationRecord["integrityIssues"]> = [];
  const markerIndex = params.background.indexOf(EXTERNAL_BACKGROUND_MARKER);
  const coreBackground = (
    markerIndex >= 0
      ? params.background.slice(0, markerIndex)
      : params.background
  ).trimEnd();
  const externalSummary =
    markerIndex >= 0
      ? params.background
          .slice(markerIndex + EXTERNAL_BACKGROUND_MARKER.length)
          .trim()
      : "";
  const emptyBackground = /^# Background:[^\r\n]*$/u.test(
    coreBackground.trim(),
  );
  let background = "";
  if (!emptyBackground) {
    try {
      validateCoreBackgroundMarkdown(coreBackground);
      background = `${coreBackground}\n`;
      preparation = completeRecoveredStage(preparation, "background");
    } catch (error) {
      preparation = recordOptionalKnowledgeFailure(
        preparation,
        "background",
        conciseFailure(error),
        issues,
      );
    }
  } else if (stageStatusOf(preparation, "background") === "running") {
    preparation = recordOptionalKnowledgeFailure(
      preparation,
      "background",
      "上一轮论文背景写入未完整结束",
      issues,
    );
  } else if (stageStatusOf(preparation, "background") === "complete") {
    preparation = recordOptionalKnowledgeFailure(
      preparation,
      "background",
      "论文背景完成记录与文件内容不一致",
      issues,
    );
  }
  preparation = closeStagesAfterTerminal(
    preparation,
    "background",
    issues.some((issue) => issue.stage === "background"),
  );

  let terminology = "";
  try {
    const terminologyCount = countTerminologyEntries(
      params.terminology,
      params.paperMarkdown,
    );
    if (terminologyCount > 0) terminology = params.terminology;
    if (terminologyCount >= MINIMUM_TERMINOLOGY_ENTRIES) {
      preparation = completeRecoveredStage(preparation, "terminology");
    } else if (stageStatusOf(preparation, "terminology") === "running") {
      preparation = recordOptionalKnowledgeFailure(
        preparation,
        "terminology",
        `上一轮术语写入未达到最低 ${MINIMUM_TERMINOLOGY_ENTRIES} 项`,
        issues,
      );
    } else if (stageStatusOf(preparation, "terminology") === "complete") {
      preparation = recordOptionalKnowledgeFailure(
        preparation,
        "terminology",
        `术语完成记录不足 ${MINIMUM_TERMINOLOGY_ENTRIES} 项`,
        issues,
      );
    }
  } catch (error) {
    terminology = "";
    preparation = recordOptionalKnowledgeFailure(
      preparation,
      "terminology",
      conciseFailure(error),
      issues,
    );
  }
  preparation = closeStagesAfterTerminal(
    preparation,
    "terminology",
    issues.some((issue) => issue.stage === "terminology"),
  );

  try {
    const backgroundResearch = JSON.parse(
      params.backgroundSources,
    ) as BackgroundResearchRecord;
    validateBackgroundResearchRecord(
      backgroundResearch,
      params.parentItemKey,
      params.fullMdSha256,
    );
    const hasSources = backgroundResearch.sources.length > 0;
    if (hasSources !== Boolean(externalSummary)) {
      throw new Error(
        "External background summary and source record are inconsistent",
      );
    }
    if (
      hasSources &&
      (await sha256(externalSummary)) !== backgroundResearch.summarySha256
    ) {
      throw new Error(
        "External background summary does not match its source record",
      );
    }
    if (hasSources && background) {
      background = `${background.trimEnd()}\n\n${EXTERNAL_BACKGROUND_MARKER}\n\n${externalSummary}\n`;
    }
    if (backgroundResearch.status === "complete") {
      preparation = completeRecoveredStage(preparation, "external");
    } else if (
      backgroundResearch.status === "empty" &&
      !backgroundResearch.queries.length
    ) {
      preparation = updatePreparationStages(preparation, [
        {
          id: "external",
          status: "skipped",
          detail: "论文分析未提出外部检索问题",
        },
      ]);
    } else if (
      backgroundResearch.status === "warning" ||
      backgroundResearch.status === "empty"
    ) {
      preparation = updatePreparationStages(preparation, [
        { id: "external", status: "warning" },
      ]);
    } else if (stageStatusOf(preparation, "external") === "running") {
      preparation = recordOptionalKnowledgeFailure(
        preparation,
        "external",
        "上一轮外部知识写入未完整结束",
        issues,
      );
    } else if (stageStatusOf(preparation, "external") === "complete") {
      preparation = recordOptionalKnowledgeFailure(
        preparation,
        "external",
        "外部知识完成记录与文件内容不一致",
        issues,
      );
    }
  } catch (error) {
    preparation = recordOptionalKnowledgeFailure(
      preparation,
      "external",
      conciseFailure(error),
      issues,
    );
  }
  return {
    preparation: updatePreparationIntegrityIssues(preparation, issues),
    background,
    terminology,
  };
}

function completeRecoveredStage(
  preparation: PreparationRecord,
  id: "background" | "terminology" | "external",
): PreparationRecord {
  return updatePreparationStages(preparation, [{ id, status: "complete" }]);
}

function recordOptionalKnowledgeFailure(
  preparation: PreparationRecord,
  stage: "background" | "terminology" | "external",
  detail: string,
  issues: NonNullable<PreparationRecord["integrityIssues"]>,
): PreparationRecord {
  const status = stageStatusOf(preparation, stage);
  if (status === "running") return preparation;
  if (status === "pending") {
    const updates: Array<{
      id: PreparationStageId;
      status: PreparationStageStatus;
      detail?: string;
    }> = [
      {
        id: stage,
        status: stage === "external" ? "warning" : "error",
        detail,
      },
    ];
    if (stage === "background") {
      updates.push(
        { id: "terminology", status: "skipped", detail: "论文背景不可用" },
        { id: "external", status: "skipped", detail: "论文背景不可用" },
      );
    } else if (stage === "terminology") {
      updates.push({
        id: "external",
        status: "skipped",
        detail: "核心术语阶段未完成",
      });
    }
    return updatePreparationStages(preparation, updates);
  }
  issues.push({ stage, detail, detectedAt: new Date().toISOString() });
  return preparation;
}

function closeStagesAfterTerminal(
  preparation: PreparationRecord,
  stage: "background" | "terminology",
  hasIntegrityIssue = false,
): PreparationRecord {
  if (
    !hasIntegrityIssue &&
    !["warning", "error", "skipped"].includes(stageStatusOf(preparation, stage))
  ) {
    return preparation;
  }
  return updatePreparationStages(
    preparation,
    stage === "background"
      ? [
          {
            id: "terminology",
            status: "skipped",
            detail: "论文背景阶段已停止",
          },
          {
            id: "external",
            status: "skipped",
            detail: "论文背景阶段已停止",
          },
        ]
      : [
          {
            id: "external",
            status: "skipped",
            detail: "核心术语阶段已停止",
          },
        ],
  );
}

function stageStatusOf(
  preparation: PreparationRecord,
  stage: PreparationStageId,
): PreparationStageStatus {
  return (
    preparation.stages.find((candidate) => candidate.id === stage)?.status ??
    "pending"
  );
}

function updatePreparationIntegrityIssues(
  preparation: PreparationRecord,
  issues: NonNullable<PreparationRecord["integrityIssues"]>,
): PreparationRecord {
  const current = preparation.integrityIssues ?? [];
  const normalized = issues.map((issue) => {
    const existing = current.find(
      (candidate) =>
        candidate.stage === issue.stage && candidate.detail === issue.detail,
    );
    return existing ? { ...existing } : { ...issue };
  });
  if (JSON.stringify(current) === JSON.stringify(normalized))
    return preparation;
  return {
    ...preparation,
    integrityIssues: normalized,
    updatedAt: new Date().toISOString(),
  };
}

function conciseFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 240);
}

export function paperIndexMatches(
  actual: PaperIndex | null,
  expected: PaperIndex,
): actual is PaperIndex {
  if (
    !actual ||
    actual.schemaVersion !== expected.schemaVersion ||
    actual.parentItemKey !== expected.parentItemKey ||
    actual.fullMdSha256 !== expected.fullMdSha256 ||
    actual.manifestSha256 !== expected.manifestSha256 ||
    actual.totalChars !== expected.totalChars ||
    !Array.isArray(actual.chunks) ||
    actual.chunks.length !== expected.chunks.length ||
    typeof actual.updatedAt !== "string" ||
    Number.isNaN(Date.parse(actual.updatedAt))
  ) {
    return false;
  }
  return actual.chunks.every((chunk, index) => {
    const rebuilt = expected.chunks[index];
    return (
      chunk.id === rebuilt.id &&
      chunk.heading === rebuilt.heading &&
      chunk.headingLevel === rebuilt.headingLevel &&
      chunk.sectionIndex === rebuilt.sectionIndex &&
      chunk.charStart === rebuilt.charStart &&
      chunk.charEnd === rebuilt.charEnd &&
      chunk.previousChunkId === rebuilt.previousChunkId &&
      chunk.nextChunkId === rebuilt.nextChunkId
    );
  });
}

export async function readBackgroundResearchRecord(
  context: ValidatedPaperContext,
): Promise<BackgroundResearchRecord> {
  const record = JSON.parse(
    await readRequiredText(
      getIOUtils(),
      joinPath(context.paperDir, "background-sources.json"),
    ),
  ) as BackgroundResearchRecord;
  validateBackgroundResearchRecord(
    record,
    context.identity.parentItemKey,
    context.fullMdSha256,
  );
  return record;
}

function validateBackgroundResearchRecord(
  record: BackgroundResearchRecord,
  parentItemKey: string,
  fullMdSha256: string,
): void {
  const validStatuses = ["pending", "complete", "empty", "warning"];
  if (
    !record ||
    typeof record !== "object" ||
    record.schemaVersion !== PAPER_CONTEXT_SCHEMA_VERSION ||
    record.parentItemKey !== parentItemKey ||
    record.fullMdSha256 !== fullMdSha256 ||
    !validStatuses.includes(record.status) ||
    !Array.isArray(record.queries) ||
    record.queries.length > 3 ||
    record.queries.some(
      (query) => typeof query !== "string" || !query.trim(),
    ) ||
    !Array.isArray(record.sources) ||
    record.sources.length > 3 ||
    (record.failures !== undefined && !Array.isArray(record.failures)) ||
    (record.researchedAt !== undefined &&
      Number.isNaN(Date.parse(record.researchedAt))) ||
    (record.summarySha256 !== undefined &&
      !/^[a-f0-9]{64}$/i.test(record.summarySha256))
  ) {
    throw new Error(
      "Background research record does not match the paper context",
    );
  }
  for (const source of record.sources) validateBackgroundSource(source);
  for (const failure of record.failures ?? []) {
    if (
      !failure ||
      typeof failure.provider !== "string" ||
      !failure.provider.trim() ||
      typeof failure.message !== "string" ||
      !failure.message.trim()
    ) {
      throw new Error("Background research record has an invalid failure");
    }
  }
  if (record.status === "complete" && !record.sources.length) {
    throw new Error("Completed background research has no sources");
  }
  if (record.status === "empty" && record.sources.length) {
    throw new Error("Empty background research unexpectedly has sources");
  }
  if (record.sources.length > 0 !== Boolean(record.summarySha256)) {
    throw new Error(
      "Background research summary hash does not match its sources",
    );
  }
  if (record.status === "pending") {
    if (
      record.researchedAt ||
      record.queries.length ||
      record.sources.length ||
      (record.failures?.length ?? 0)
    ) {
      throw new Error("Pending background research contains completed data");
    }
  } else if (!record.researchedAt) {
    throw new Error("Finished background research has no completion time");
  }
}

function validateBackgroundSource(source: BackgroundSource): void {
  if (
    !source ||
    typeof source.title !== "string" ||
    !source.title.trim() ||
    typeof source.url !== "string" ||
    typeof source.snippet !== "string" ||
    !source.snippet.trim() ||
    !["official", "academic", "community"].includes(source.sourceLevel) ||
    typeof source.purpose !== "string" ||
    !source.purpose.trim()
  ) {
    throw new Error("Background research record has an invalid source");
  }
  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    throw new Error(`Background source URL is invalid: ${source.url}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`Background source must use HTTPS: ${source.url}`);
  }
}

function createBackgroundResearchRecord(
  parentItemKey: string,
  fullMdSha256: string,
): BackgroundResearchRecord {
  return {
    schemaVersion: PAPER_CONTEXT_SCHEMA_VERSION,
    parentItemKey,
    fullMdSha256,
    status: "pending",
    queries: [],
    sources: [],
    failures: [],
  };
}

export async function persistCoreBackground(params: {
  context: ValidatedPaperContext;
  markdown: string;
  assertActive?: () => void;
}): Promise<void> {
  const value = params.markdown.trim();
  if (!value) throw new Error("Core paper background is empty");
  validateCoreBackgroundMarkdown(value);
  const markdown = [
    `# Background: ${params.context.identity.title || "Untitled paper"}`,
    "",
    value,
    "",
  ].join("\n");
  await withPaperFileLock(params.context.paperDir, async () => {
    const io = getIOUtils();
    await assertCurrentPaperContext(io, params.context);
    params.assertActive?.();
    await writeText(
      io,
      joinPath(params.context.paperDir, "background.md"),
      markdown,
    );
    params.context.background = markdown;
  });
}

export async function persistBackgroundResearch(params: {
  context: ValidatedPaperContext;
  summary: string;
  queries: string[];
  sources: BackgroundSource[];
  failures?: Array<{ provider: string; message: string }>;
  status?: BackgroundResearchRecord["status"];
  assertActive?: () => void;
}): Promise<void> {
  const summary = params.summary.trim();
  const sources = params.sources.map((source) => {
    const normalized: BackgroundSource = {
      title: source.title.trim(),
      url: source.url.trim(),
      snippet: source.snippet.trim(),
      sourceLevel: source.sourceLevel,
      purpose: source.purpose.trim(),
    };
    validateBackgroundSource(normalized);
    return { ...normalized, url: new URL(normalized.url).href };
  });
  if (sources.length > 0 && !summary) {
    throw new Error("External sources require a background summary");
  }
  if (sources.length === 0 && summary) {
    throw new Error("External background without sources is not allowed");
  }
  const record: BackgroundResearchRecord = {
    schemaVersion: PAPER_CONTEXT_SCHEMA_VERSION,
    parentItemKey: params.context.identity.parentItemKey,
    fullMdSha256: params.context.fullMdSha256,
    status:
      params.status ??
      (params.failures?.length
        ? "warning"
        : sources.length > 0
          ? "complete"
          : "empty"),
    researchedAt: new Date().toISOString(),
    summarySha256: summary ? await sha256(summary) : undefined,
    queries: params.queries.map((query) => query.trim()).filter(Boolean),
    sources,
    failures: params.failures ?? [],
  };
  validateBackgroundResearchRecord(
    record,
    params.context.identity.parentItemKey,
    params.context.fullMdSha256,
  );
  await withPaperFileLock(params.context.paperDir, async () => {
    const io = getIOUtils();
    await assertCurrentPaperContext(io, params.context);
    params.assertActive?.();
    const backgroundPath = joinPath(params.context.paperDir, "background.md");
    const current = await readRequiredText(io, backgroundPath);
    const marker = EXTERNAL_BACKGROUND_MARKER;
    const base = current.includes(marker)
      ? current.slice(0, current.indexOf(marker)).trimEnd()
      : current.trimEnd();
    validateCoreBackgroundMarkdown(base);
    const merged = summary
      ? `${base}\n\n${marker}\n\n${summary}\n`
      : `${base}\n`;
    const sourcesPath = joinPath(
      params.context.paperDir,
      "background-sources.json",
    );
    const previousSources = await readRequiredText(io, sourcesPath);
    const previousResearch = JSON.parse(
      previousSources,
    ) as BackgroundResearchRecord;
    validateBackgroundResearchRecord(
      previousResearch,
      params.context.identity.parentItemKey,
      params.context.fullMdSha256,
    );
    if (previousResearch.status !== "pending") {
      throw new Error("External background research is already terminal");
    }
    let sourcesWritten = false;
    let backgroundWritten = false;
    try {
      await assertCurrentPaperContext(io, params.context);
      params.assertActive?.();
      await writeJson(io, sourcesPath, record);
      sourcesWritten = true;
      await assertCurrentPaperContext(io, params.context);
      params.assertActive?.();
      await writeText(io, backgroundPath, merged);
      backgroundWritten = true;
      await assertCurrentPaperContext(io, params.context);
      params.assertActive?.();
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      if (backgroundWritten) {
        try {
          await writeText(io, backgroundPath, current);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (sourcesWritten) {
        try {
          await writeText(io, sourcesPath, previousSources);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "External background write failed and rollback also failed",
        );
      }
      throw error;
    }
    params.context.background = merged;
  });
}

export async function persistTerminology(params: {
  context: ValidatedPaperContext;
  entries: TerminologyEntry[];
  assertActive?: () => void;
}): Promise<void> {
  if (!params.entries.length) return;
  await withPaperFileLock(params.context.paperDir, () =>
    persistTerminologyNow(params),
  );
}

async function persistTerminologyNow(params: {
  context: ValidatedPaperContext;
  entries: TerminologyEntry[];
  assertActive?: () => void;
}): Promise<void> {
  const io = getIOUtils();
  await assertCurrentPaperContext(io, params.context);
  params.assertActive?.();
  const path = joinPath(params.context.paperDir, "terminology.md");
  let markdown = await readRequiredText(io, path);
  const existingSources = new Set(
    parseTerminologyRows(markdown, params.context.markdown).map((row) =>
      row.canonical.toLocaleLowerCase(),
    ),
  );
  const now = new Date().toISOString();
  for (const entry of params.entries) {
    if (existingSources.size >= MAXIMUM_TERMINOLOGY_ENTRIES) break;
    const observed = entry.observed.trim();
    const canonical = entry.canonical.trim();
    const translation = entry.translation.trim();
    const category = entry.category.trim();
    const definition = entry.definition.trim();
    const evidence = entry.evidence.trim();
    if (
      !observed ||
      !canonical ||
      !translation ||
      !category ||
      !definition ||
      !evidence
    ) {
      throw new Error("Terminology entry contains an empty field");
    }
    if (existingSources.has(canonical.toLocaleLowerCase())) continue;
    markdown += `| ${escapeMarkdownCell(observed)} | ${escapeMarkdownCell(canonical)} | ${escapeMarkdownCell(translation)} | ${escapeMarkdownCell(category)} | ${escapeMarkdownCell(definition)} | ${escapeMarkdownCell(evidence)} | ${entry.sourceLevel} | ${entry.confidence} | ${now} |\n`;
    existingSources.add(canonical.toLocaleLowerCase());
  }
  parseTerminologyRows(markdown, params.context.markdown);
  await assertCurrentPaperContext(io, params.context);
  params.assertActive?.();
  await writeText(io, path, markdown);
  params.context.terminology = markdown;
}

async function assertCurrentPaperContext(
  io: IOUtilsLike,
  context: ValidatedPaperContext,
): Promise<void> {
  await assertCurrentPaperSource(io, context);
  await readPreparationRecordFromPath(
    io,
    joinPath(context.paperDir, "_preparation.json"),
    context.identity.parentItemKey,
    context.fullMdSha256,
  );
}

async function assertCurrentPaperSource(
  io: IOUtilsLike,
  context: ValidatedPaperContext,
): Promise<void> {
  const sourcePath = joinPath(context.paperDir, "_paper_source.json");
  const source = JSON.parse(
    await readRequiredText(io, sourcePath),
  ) as Partial<PaperSourceRecord>;
  if (
    source.schemaVersion !== PAPER_CONTEXT_SCHEMA_VERSION ||
    source.libraryID !== context.identity.libraryID ||
    source.parentItemKey !== context.identity.parentItemKey ||
    source.attachmentID !== context.identity.attachmentID ||
    source.attachmentKey !== context.identity.attachmentKey ||
    source.fullMdSha256 !== context.fullMdSha256 ||
    typeof source.mineruCacheDir !== "string" ||
    normalizeAbsolutePath(source.mineruCacheDir) !==
      normalizeAbsolutePath(context.mineruCacheDir) ||
    typeof source.fullMdPath !== "string" ||
    normalizeAbsolutePath(source.fullMdPath) !==
      normalizeAbsolutePath(context.fullMdPath)
  ) {
    throw new Error(
      "Paper context changed before knowledge files could be written",
    );
  }
  const currentMarkdown = await readRequiredText(io, context.fullMdPath);
  if ((await sha256(currentMarkdown)) !== context.fullMdSha256) {
    throw new Error(
      "MinerU full.md changed before knowledge files could be written",
    );
  }
}

export async function readPreparationRecord(
  context: ValidatedPaperContext,
): Promise<PreparationRecord> {
  return readPreparationRecordFromPath(
    getIOUtils(),
    joinPath(context.paperDir, "_preparation.json"),
    context.identity.parentItemKey,
    context.fullMdSha256,
  );
}

export async function readCurrentPaperBackground(
  context: ValidatedPaperContext,
): Promise<string> {
  return withPaperFileLock(context.paperDir, async () => {
    const io = getIOUtils();
    await assertCurrentPaperContext(io, context);
    const markdown = await readRequiredText(
      io,
      joinPath(context.paperDir, "background.md"),
    );
    const markerIndex = markdown.indexOf(EXTERNAL_BACKGROUND_MARKER);
    const core = (
      markerIndex >= 0 ? markdown.slice(0, markerIndex) : markdown
    ).trimEnd();
    validateCoreBackgroundMarkdown(core);
    context.background = markdown;
    return markdown;
  });
}

export async function setPreparationStage(params: {
  context: ValidatedPaperContext;
  id: PreparationStageId;
  status: PreparationStageStatus;
  detail?: string;
  assertActive?: () => void;
}): Promise<PreparationRecord> {
  return setPreparationStages(params.context, [params], params.assertActive);
}

export async function setPreparationStages(
  context: ValidatedPaperContext,
  updates: Array<{
    id: PreparationStageId;
    status: PreparationStageStatus;
    detail?: string;
  }>,
  assertActive?: () => void,
): Promise<PreparationRecord> {
  return withPaperFileLock(context.paperDir, async () => {
    const io = getIOUtils();
    await assertCurrentPaperSource(io, context);
    const path = joinPath(context.paperDir, "_preparation.json");
    const current = await readPreparationRecordFromPath(
      io,
      path,
      context.identity.parentItemKey,
      context.fullMdSha256,
    );
    assertActive?.();
    const next = updatePreparationStages(current, updates);
    if (next !== current) {
      await assertCurrentPaperSource(io, context);
      assertActive?.();
      await writePreparationRecord(io, path, next);
    }
    return next;
  });
}

export async function cleanupPermanentlyDeletedPaperContexts(): Promise<void> {
  const io = getIOUtils();
  const contextRoot = joinPath(resolveZoteroDataDir(), CONTEXT_ROOT_NAME);
  if (!(await io.exists(contextRoot))) return;
  for (const childPath of await io.getChildren(contextRoot)) {
    await withPaperFileLock(childPath, async () => {
      if (!(await io.exists(childPath))) return;
      const sourcePath = joinPath(childPath, "_paper_source.json");
      if (!(await io.exists(sourcePath))) {
        throw new Error(
          `Context directory is missing _paper_source.json: ${childPath}`,
        );
      }
      const source = validatePaperSourceForCleanup(
        JSON.parse(await readRequiredText(io, sourcePath)),
        sourcePath,
      );
      validateContextDeletionTarget(contextRoot, childPath, source);
      if (!Zotero.Libraries.exists(source.libraryID)) {
        throw new Error(
          `Cannot verify paper deletion because Zotero library ${source.libraryID} is unavailable: ${childPath}`,
        );
      }
      const liveItem = Zotero.Items.getByLibraryAndKey(
        source.libraryID,
        source.parentItemKey,
      );
      if (liveItem) return;
      await io.remove(childPath, { recursive: true, ignoreAbsent: false });
    });
  }
}

function validatePaperSourceForCleanup(
  value: unknown,
  sourcePath: string,
): PaperSourceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Paper source record is invalid: ${sourcePath}`);
  }
  const source = value as Record<string, unknown>;
  if (
    ![1, 2, PAPER_CONTEXT_SCHEMA_VERSION].includes(
      Number(source.schemaVersion),
    ) ||
    !Number.isInteger(source.libraryID) ||
    Number(source.libraryID) <= 0 ||
    !/^[A-Z0-9]{8}$/.test(String(source.parentItemKey || "")) ||
    !Number.isInteger(source.attachmentID) ||
    Number(source.attachmentID) <= 0 ||
    !/^[A-Z0-9]{8}$/.test(String(source.attachmentKey || "")) ||
    !/^[a-f0-9]{64}$/i.test(String(source.fullMdSha256 || ""))
  ) {
    throw new Error(`Paper source record is incomplete: ${sourcePath}`);
  }
  return source as unknown as PaperSourceRecord;
}

export function validateContextDeletionTarget(
  contextRoot: string,
  childPath: string,
  source: Pick<PaperSourceRecord, "parentItemKey">,
): void {
  assertPathInside(contextRoot, childPath);
  const folderName = basename(childPath);
  if (!/^[A-Z0-9]{8}$/.test(folderName)) {
    throw new Error(
      `Context directory name is not a Zotero item key: ${childPath}`,
    );
  }
  if (source.parentItemKey !== folderName) {
    throw new Error(`Context directory identity mismatch: ${childPath}`);
  }
}

function resolvePaperIdentity(attachmentItemID: number): PaperIdentity {
  const attachment = Zotero.Items.get(attachmentItemID);
  if (!attachment || !attachment.isAttachment()) {
    throw new Error(
      `Reader item is not a Zotero attachment: ${attachmentItemID}`,
    );
  }
  if (!attachment.parentItemID) {
    throw new Error(
      `Attachment has no bibliographic parent: ${attachment.key}`,
    );
  }
  const parent = Zotero.Items.get(attachment.parentItemID);
  if (!parent || parent.isAttachment()) {
    throw new Error(
      `Cannot resolve parent item for attachment: ${attachment.key}`,
    );
  }
  return {
    libraryID: parent.libraryID,
    parentItemKey: parent.key,
    attachmentID: attachment.id,
    attachmentKey: attachment.key,
    title: String(parent.getField("title") || ""),
    doi: String(parent.getField("DOI") || ""),
  };
}

function resolveZoteroDataDir(): string {
  const dataDir = (Zotero as unknown as { DataDirectory?: { dir?: string } })
    .DataDirectory?.dir;
  if (!dataDir?.trim()) throw new Error("Cannot resolve Zotero data directory");
  return dataDir.trim();
}

function getIOUtils(): IOUtilsLike {
  const io = (globalThis as unknown as { IOUtils?: IOUtilsLike }).IOUtils;
  if (!io) throw new Error("IOUtils is unavailable in this Zotero runtime");
  return io;
}

async function validateExistingPaperSource(
  io: IOUtilsLike,
  paperDir: string,
  expected: PaperSourceRecord,
): Promise<Partial<PaperSourceRecord> | null> {
  const sourcePath = joinPath(paperDir, "_paper_source.json");
  if (!(await io.exists(sourcePath))) {
    if ((await io.getChildren(paperDir)).length > 0) {
      throw new Error(
        `Existing paper context is missing _paper_source.json: ${paperDir}`,
      );
    }
    return null;
  }
  const existing = validateExistingPaperSourceRecord(
    JSON.parse(await readRequiredText(io, sourcePath)),
    expected,
    sourcePath,
  );
  return existing;
}

export function validateExistingPaperSourceRecord(
  value: unknown,
  expected: PaperSourceRecord,
  sourcePath: string,
): Partial<PaperSourceRecord> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Paper source record is invalid: ${sourcePath}`);
  }
  const existing = value as Partial<PaperSourceRecord>;
  const schemaVersion = Number(existing.schemaVersion);
  if (
    ![1, 2, PAPER_CONTEXT_SCHEMA_VERSION].includes(schemaVersion) ||
    !Number.isInteger(existing.libraryID) ||
    Number(existing.libraryID) <= 0 ||
    !/^[A-Z0-9]{8}$/.test(String(existing.parentItemKey || "")) ||
    !Number.isInteger(existing.attachmentID) ||
    Number(existing.attachmentID) <= 0 ||
    !/^[A-Z0-9]{8}$/.test(String(existing.attachmentKey || "")) ||
    typeof existing.title !== "string" ||
    typeof existing.doi !== "string" ||
    typeof existing.mineruCacheDir !== "string" ||
    normalizeAbsolutePath(existing.mineruCacheDir) !==
      normalizeAbsolutePath(expected.mineruCacheDir) ||
    typeof existing.fullMdPath !== "string" ||
    normalizeAbsolutePath(existing.fullMdPath) !==
      normalizeAbsolutePath(expected.fullMdPath) ||
    !/^[a-f0-9]{64}$/i.test(String(existing.fullMdSha256 || "")) ||
    typeof existing.updatedAt !== "string" ||
    Number.isNaN(Date.parse(existing.updatedAt)) ||
    existing.parentItemKey !== expected.parentItemKey ||
    existing.libraryID !== expected.libraryID ||
    existing.attachmentID !== expected.attachmentID ||
    existing.attachmentKey !== expected.attachmentKey
  ) {
    throw new Error(
      `Paper context source is invalid or conflicting: ${sourcePath}`,
    );
  }
  return existing;
}

async function readRequiredText(
  io: IOUtilsLike,
  path: string,
): Promise<string> {
  if (!(await io.exists(path)))
    throw new Error(`Required file is missing: ${path}`);
  const raw = await io.read(path);
  return textDecoder.decode(
    raw instanceof Uint8Array ? raw : new Uint8Array(raw),
  );
}

async function readJsonIfExists<T>(
  io: IOUtilsLike,
  path: string,
): Promise<T | null> {
  if (!(await io.exists(path))) return null;
  return JSON.parse(await readRequiredText(io, path)) as T;
}

async function writeJson(io: IOUtilsLike, path: string, value: unknown) {
  await writeText(io, path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(io: IOUtilsLike, path: string, value: string) {
  await io.write(path, textEncoder.encode(value), { tmpPath: `${path}.tmp` });
}

async function ensureJsonFile(io: IOUtilsLike, path: string, value: unknown) {
  if (!(await io.exists(path))) await writeJson(io, path, value);
}

async function ensureTextFile(io: IOUtilsLike, path: string, value: string) {
  if (!(await io.exists(path))) await writeText(io, path, value);
}

export function createPreparationRecord(
  parentItemKey: string,
  fullMdSha256: string,
  now = new Date().toISOString(),
): PreparationRecord {
  const required = new Set<PreparationStageId>(["source", "index"]);
  return {
    schemaVersion: PAPER_CONTEXT_SCHEMA_VERSION,
    parentItemKey,
    fullMdSha256,
    overall: "preparing",
    stages: (Object.keys(PREPARATION_STAGE_FILES) as PreparationStageId[]).map(
      (id) => ({
        id,
        file: PREPARATION_STAGE_FILES[id],
        required: required.has(id),
        status: "pending",
      }),
    ),
    integrityIssues: [],
    updatedAt: now,
  };
}

export function updatePreparationStages(
  record: PreparationRecord,
  updates: Array<{
    id: PreparationStageId;
    status: PreparationStageStatus;
    detail?: string;
  }>,
  now = new Date().toISOString(),
): PreparationRecord {
  const updateMap = new Map(updates.map((update) => [update.id, update]));
  const stages = record.stages.map((stage) => ({ ...stage }));
  let changed = false;
  for (const stage of stages) {
    const update = updateMap.get(stage.id);
    if (!update || !canApplyStageTransition(stage.status, update.status)) {
      continue;
    }
    if (
      (update.status === "running" || update.status === "complete") &&
      !previousStageIsComplete(stages, stage.id)
    ) {
      continue;
    }
    const previousStatus = stage.status;
    changed = true;
    stage.status = update.status;
    stage.startedAt =
      update.status === "pending" ? undefined : (stage.startedAt ?? now);
    stage.completedAt = TERMINAL_PREPARATION_STATUSES.has(update.status)
      ? previousStatus === update.status
        ? (stage.completedAt ?? now)
        : now
      : undefined;
    stage.detail =
      update.detail?.trim() ||
      (previousStatus === update.status ? stage.detail : undefined);
  }
  if (!changed) return record;
  const overall = derivePreparationOverall(stages);
  return { ...record, stages, overall, updatedAt: now };
}

function derivePreparationOverall(
  stages: PreparationRecord["stages"],
): PreparationRecord["overall"] {
  const required = stages.filter((stage) => stage.required);
  const coreReady = required.every((stage) => stage.status === "complete");
  if (required.some((stage) => stage.status === "error")) return "error";
  if (
    coreReady &&
    stages.every((stage) => TERMINAL_PREPARATION_STATUSES.has(stage.status))
  ) {
    return "ready";
  }
  return coreReady ? "core-ready" : "preparing";
}

function canApplyStageTransition(
  current: PreparationStageStatus,
  next: PreparationStageStatus,
): boolean {
  if (current === next) return false;
  if (TERMINAL_PREPARATION_STATUSES.has(current)) {
    return false;
  }
  return !(current === "running" && next === "pending");
}

function previousStageIsComplete(
  stages: PreparationRecord["stages"],
  id: PreparationStageId,
): boolean {
  const index = stages.findIndex((stage) => stage.id === id);
  if (index <= 0) return true;
  return stages[index - 1]?.status === "complete";
}

async function readPreparationRecordFromPath(
  io: IOUtilsLike,
  path: string,
  parentItemKey: string,
  fullMdSha256: string,
): Promise<PreparationRecord> {
  const record = JSON.parse(
    await readRequiredText(io, path),
  ) as PreparationRecord;
  const expectedIds = Object.keys(
    PREPARATION_STAGE_FILES,
  ) as PreparationStageId[];
  const validStatuses = new Set<PreparationStageStatus>([
    "pending",
    "running",
    "complete",
    "warning",
    "error",
    "skipped",
  ]);
  const validOverall = new Set<PreparationRecord["overall"]>([
    "preparing",
    "core-ready",
    "ready",
    "error",
  ]);
  if (
    record.schemaVersion !== PAPER_CONTEXT_SCHEMA_VERSION ||
    record.parentItemKey !== parentItemKey ||
    record.fullMdSha256 !== fullMdSha256 ||
    !Array.isArray(record.stages) ||
    record.stages.length !== expectedIds.length ||
    record.stages.some((stage, index) => {
      const id = expectedIds[index];
      return (
        stage.id !== id ||
        stage.file !== PREPARATION_STAGE_FILES[id] ||
        stage.required !== (id === "source" || id === "index") ||
        !validStatuses.has(stage.status) ||
        (stage.startedAt !== undefined &&
          typeof stage.startedAt !== "string") ||
        (stage.completedAt !== undefined &&
          typeof stage.completedAt !== "string") ||
        (stage.detail !== undefined && typeof stage.detail !== "string")
      );
    }) ||
    record.stages.some(
      (stage, index) =>
        index > 0 &&
        (stage.status === "running" || stage.status === "complete") &&
        record.stages[index - 1]?.status !== "complete",
    ) ||
    (record.integrityIssues !== undefined &&
      (!Array.isArray(record.integrityIssues) ||
        record.integrityIssues.some(
          (issue) =>
            !issue ||
            !["background", "terminology", "external"].includes(issue.stage) ||
            typeof issue.detail !== "string" ||
            !issue.detail.trim() ||
            typeof issue.detectedAt !== "string" ||
            Number.isNaN(Date.parse(issue.detectedAt)),
        ) ||
        new Set(record.integrityIssues.map((issue) => issue.stage)).size !==
          record.integrityIssues.length)) ||
    !validOverall.has(record.overall) ||
    typeof record.updatedAt !== "string" ||
    Number.isNaN(Date.parse(record.updatedAt))
  ) {
    throw new Error("Preparation record does not match the paper context");
  }
  if (derivePreparationOverall(record.stages) !== record.overall) {
    throw new Error("Preparation record overall status is inconsistent");
  }
  return { ...record, integrityIssues: record.integrityIssues ?? [] };
}

async function writePreparationRecord(
  io: IOUtilsLike,
  path: string,
  record: PreparationRecord,
): Promise<void> {
  await writeJson(io, path, record);
}

async function withPaperFileLock<T>(
  paperDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = normalizeAbsolutePath(paperDir);
  const previous = paperFileWrites.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  paperFileWrites.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (paperFileWrites.get(key) === tail) paperFileWrites.delete(key);
  }
}

export function migrateTerminologyMarkdown(
  markdown: string,
  title: string,
  paperMarkdown?: string,
): string {
  if (markdown.includes("| Observed expression | Canonical English |")) {
    const header = markdown.split(/\r?\n/).filter((line) => {
      if (!line.startsWith("|") || /^\|\s*-/.test(line)) return true;
      if (line.includes("Observed expression")) return true;
      const observed = splitMarkdownTableRow(line)[0];
      return !paperMarkdown || paperMarkdown.includes(observed);
    });
    return `${header.join("\n").trimEnd()}\n`;
  }
  let result = createTerminologyMarkdown(title);
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith("|") || /^\|\s*-/.test(line)) continue;
    const cells = line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length < 3 || /source|原文/i.test(cells[0])) continue;
    const [observed, translation, evidence, updatedAt = ""] = cells;
    if (!observed || !translation) continue;
    if (paperMarkdown && !paperMarkdown.includes(observed)) continue;
    result += `| ${escapeMarkdownCell(observed)} | ${escapeMarkdownCell(observed)} | ${escapeMarkdownCell(translation)} | legacy | Migrated from schema v1 | ${escapeMarkdownCell(evidence || "legacy entry")} | paper | medium | ${escapeMarkdownCell(updatedAt || new Date().toISOString())} |\n`;
  }
  return result;
}

export function countTerminologyEntries(
  markdown: string,
  paperMarkdown?: string,
): number {
  return parseTerminologyRows(markdown, paperMarkdown).length;
}

export function validateCoreBackgroundMarkdown(markdown: string): void {
  if (!markdown.split(/\r?\n/).some((line) => line.trim() === "## 论文依据")) {
    throw new Error("Core paper background is missing section: 论文依据");
  }
  for (const heading of [
    "所属领域",
    "研究问题",
    "工作流",
    "方法组件",
    "实验与评价语境",
  ]) {
    if (!readMarkdownSection(markdown, heading)) {
      throw new Error(`Core paper background is missing section: ${heading}`);
    }
  }
}

type ParsedTerminologyRow = {
  observed: string;
  canonical: string;
  translation: string;
};

function parseTerminologyRows(
  markdown: string,
  paperMarkdown?: string,
): ParsedTerminologyRow[] {
  const rows: ParsedTerminologyRow[] = [];
  const seen = new Set<string>();
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trimStart().startsWith("|")) continue;
    const cells = splitMarkdownTableRow(line);
    if (cells[0] === "Observed expression") continue;
    if (cells.length && cells.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      continue;
    }
    if (cells.length !== 9 || cells.some((cell) => !cell)) {
      throw new Error("Terminology file contains an incomplete table row");
    }
    const [
      observed,
      canonical,
      translation,
      _category,
      _definition,
      _evidence,
      sourceLevel,
      confidence,
      updatedAt,
    ] = cells;
    if (paperMarkdown && !paperMarkdown.includes(observed)) {
      throw new Error(
        `Terminology expression is absent from validated Markdown: ${observed}`,
      );
    }
    if (sourceLevel !== "paper") {
      throw new Error(`Terminology source level must be paper: ${observed}`);
    }
    if (!["high", "medium", "low"].includes(confidence)) {
      throw new Error(`Terminology confidence is invalid: ${observed}`);
    }
    if (Number.isNaN(Date.parse(updatedAt))) {
      throw new Error(`Terminology timestamp is invalid: ${observed}`);
    }
    const key = canonical.toLocaleLowerCase();
    if (seen.has(key)) {
      throw new Error(`Terminology canonical term is duplicated: ${canonical}`);
    }
    seen.add(key);
    rows.push({ observed, canonical, translation });
  }
  return rows;
}

function splitMarkdownTableRow(line: string): string[] {
  const value = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\" && value[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function readMarkdownSection(markdown: string, heading: string): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `### ${heading}`);
  if (start < 0) return "";
  let end = start + 1;
  while (end < lines.length && !/^#{1,3}\s+/.test(lines[end].trim())) {
    end += 1;
  }
  return lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
}

function escapeMarkdownCell(value: string): string {
  return value
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function resolvePaperDirectory(root: string, parentItemKey: string): string {
  if (!/^[A-Z0-9]{8}$/.test(parentItemKey)) {
    throw new Error(`Invalid Zotero parent item key: ${parentItemKey}`);
  }
  const target = joinPath(root, parentItemKey);
  assertPathInside(root, target);
  return target;
}

function assertPathInside(root: string, target: string): void {
  const normalizedRoot = normalizeAbsolutePath(root);
  const normalizedTarget = normalizeAbsolutePath(target);
  if (!normalizedTarget.startsWith(`${normalizedRoot}/`)) {
    throw new Error(`Path escapes paper context root: ${target}`);
  }
}

function normalizeAbsolutePath(value: string): string {
  const slashPath = value.replace(/\\/g, "/");
  const drive = slashPath.match(/^([a-zA-Z]:)\//)?.[1]?.toLocaleLowerCase();
  const isUnc = slashPath.startsWith("//");
  const isUnix = slashPath.startsWith("/") && !isUnc;
  if (!drive && !isUnc && !isUnix) {
    throw new Error(`Path is not absolute: ${value}`);
  }
  const body = drive
    ? slashPath.slice(3)
    : isUnc
      ? slashPath.slice(2)
      : slashPath.slice(1);
  const segments: string[] = [];
  for (const segment of body.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length)
        throw new Error(`Path escapes its filesystem root: ${value}`);
      segments.pop();
      continue;
    }
    segments.push(segment.toLocaleLowerCase());
  }
  const prefix = drive ? `${drive}/` : isUnc ? "//" : "/";
  return `${prefix}${segments.join("/")}`.replace(/\/+$/, "");
}

function basename(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || "";
}

function joinPath(...parts: string[]): string {
  const separator = parts[0]?.includes("\\") ? "\\" : "/";
  return parts
    .map((part, index) =>
      index === 0
        ? part.replace(/[\\/]+$/, "")
        : part.replace(/^[\\/]+|[\\/]+$/g, ""),
    )
    .filter(Boolean)
    .join(separator);
}
