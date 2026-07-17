import {
  PAPER_CONTEXT_SCHEMA_VERSION,
  PaperIdentity,
  PaperIndex,
  PaperSourceRecord,
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
  updatedAt: string;
};

export type BackgroundResearchRecord = {
  schemaVersion: typeof PAPER_CONTEXT_SCHEMA_VERSION;
  parentItemKey: string;
  fullMdSha256: string;
  status: "pending" | "complete" | "empty" | "warning";
  researchedAt?: string;
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
const terminologyWrites = new Map<string, Promise<void>>();

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
  const fullMdSha256 = await sha256(markdown);

  const contextRoot = joinPath(dataDir, CONTEXT_ROOT_NAME);
  const paperDir = resolvePaperDirectory(contextRoot, identity.parentItemKey);
  await io.makeDirectory(paperDir, {
    createAncestors: true,
    ignoreExisting: true,
  });
  const sourceRecord: PaperSourceRecord = {
    schemaVersion: PAPER_CONTEXT_SCHEMA_VERSION,
    ...identity,
    mineruCacheDir,
    fullMdPath,
    fullMdSha256,
    updatedAt: new Date().toISOString(),
  };
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

  const indexPath = joinPath(paperDir, "index.json");
  let index = await readJsonIfExists<PaperIndex>(io, indexPath);
  if (
    !index ||
    index.schemaVersion !== PAPER_CONTEXT_SCHEMA_VERSION ||
    index.parentItemKey !== identity.parentItemKey ||
    index.fullMdSha256 !== fullMdSha256 ||
    index.totalChars !== markdown.length
  ) {
    index = buildPaperIndex({
      parentItemKey: identity.parentItemKey,
      fullMdSha256,
      markdown,
      manifest,
    });
    await writeJson(io, indexPath, index);
  }
  await writeJson(io, joinPath(paperDir, "_paper_source.json"), sourceRecord);
  const terminologyPath = joinPath(paperDir, "terminology.md");
  const backgroundPath = joinPath(paperDir, "background.md");
  const backgroundSourcesPath = joinPath(paperDir, "background-sources.json");
  const preparationPath = joinPath(paperDir, "_preparation.json");
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
    await writeJson(io, backgroundSourcesPath, {
      schemaVersion: PAPER_CONTEXT_SCHEMA_VERSION,
      parentItemKey: identity.parentItemKey,
      fullMdSha256,
      status: "pending",
      queries: [],
      sources: [],
      failures: [],
    } satisfies BackgroundResearchRecord);
    await writeJson(
      io,
      preparationPath,
      createPreparationRecord(identity.parentItemKey, fullMdSha256),
    );
  }
  const backgroundSourcesExisted = await io.exists(backgroundSourcesPath);
  const preparationExisted = await io.exists(preparationPath);
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
  await ensureJsonFile(io, backgroundSourcesPath, {
    schemaVersion: PAPER_CONTEXT_SCHEMA_VERSION,
    parentItemKey: identity.parentItemKey,
    fullMdSha256,
    status: "pending",
    queries: [],
    sources: [],
    failures: [],
  } satisfies BackgroundResearchRecord);
  await ensureJsonFile(
    io,
    preparationPath,
    createPreparationRecord(identity.parentItemKey, fullMdSha256),
  );
  const preparation = await readPreparationRecordFromPath(
    io,
    preparationPath,
    identity.parentItemKey,
    fullMdSha256,
  );
  const [terminology, background, backgroundResearch] = await Promise.all([
    readRequiredText(io, terminologyPath),
    readRequiredText(io, backgroundPath),
    readRequiredText(io, backgroundSourcesPath).then(
      (value) => JSON.parse(value) as BackgroundResearchRecord,
    ),
  ]);
  validateBackgroundResearchRecord(
    backgroundResearch,
    identity.parentItemKey,
    fullMdSha256,
  );
  const stageUpdates: Array<{
    id: PreparationStageId;
    status: PreparationStageStatus;
  }> = [
    { id: "source", status: "complete" },
    { id: "index", status: "complete" },
  ];
  if (background.includes("## 论文依据")) {
    stageUpdates.push({ id: "background", status: "complete" });
  } else if (!stageIsActiveOrFailed(preparation, "background")) {
    stageUpdates.push({ id: "background", status: "pending" });
  }
  if (hasTerminologyEntries(terminology)) {
    stageUpdates.push({ id: "terminology", status: "complete" });
  } else if (!stageIsActiveOrFailed(preparation, "terminology")) {
    stageUpdates.push({ id: "terminology", status: "pending" });
  }
  if (!preparationExisted || !backgroundSourcesExisted) {
    stageUpdates.push({
      id: "external",
      status:
        backgroundResearch.status === "complete"
          ? "complete"
          : backgroundResearch.status === "warning" ||
              backgroundResearch.status === "empty"
            ? "warning"
            : "pending",
    });
  }
  await writePreparationRecord(
    io,
    preparationPath,
    updatePreparationStages(preparation, stageUpdates),
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
    passages: retrievePassages(
      markdown,
      index,
      query.trim() || `${identity.title} ${identity.doi}`.trim(),
    ),
  };
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
  if (
    record.schemaVersion !== PAPER_CONTEXT_SCHEMA_VERSION ||
    record.parentItemKey !== parentItemKey ||
    record.fullMdSha256 !== fullMdSha256 ||
    !Array.isArray(record.queries) ||
    !Array.isArray(record.sources)
  ) {
    throw new Error(
      "Background research record does not match the paper context",
    );
  }
}

export async function persistCoreBackground(params: {
  context: ValidatedPaperContext;
  markdown: string;
}): Promise<void> {
  const value = params.markdown.trim();
  if (!value) throw new Error("Core paper background is empty");
  const markdown = [
    `# Background: ${params.context.identity.title || "Untitled paper"}`,
    "",
    value,
    "",
  ].join("\n");
  await writeText(
    getIOUtils(),
    joinPath(params.context.paperDir, "background.md"),
    markdown,
  );
  params.context.background = markdown;
}

export async function persistBackgroundResearch(params: {
  context: ValidatedPaperContext;
  summary: string;
  queries: string[];
  sources: BackgroundSource[];
  failures?: Array<{ provider: string; message: string }>;
  status?: BackgroundResearchRecord["status"];
}): Promise<void> {
  const io = getIOUtils();
  const summary = params.summary.trim();
  const sources = params.sources.map((source) => {
    let url: URL;
    try {
      url = new URL(source.url);
    } catch {
      throw new Error(`Background source URL is invalid: ${source.url}`);
    }
    if (url.protocol !== "https:") {
      throw new Error(`Background source must use HTTPS: ${source.url}`);
    }
    return {
      title: source.title.trim(),
      url: url.href,
      snippet: source.snippet.trim(),
      sourceLevel: source.sourceLevel,
      purpose: source.purpose.trim(),
    };
  });
  const backgroundPath = joinPath(params.context.paperDir, "background.md");
  const current = await readRequiredText(io, backgroundPath);
  const marker = "## 外部背景补充";
  const base = current.includes(marker)
    ? current.slice(0, current.indexOf(marker)).trimEnd()
    : current.trimEnd();
  const merged = summary ? `${base}\n\n${marker}\n\n${summary}\n` : `${base}\n`;
  await writeText(io, backgroundPath, merged);
  await writeJson(
    io,
    joinPath(params.context.paperDir, "background-sources.json"),
    {
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
      queries: params.queries.map((query) => query.trim()).filter(Boolean),
      sources,
      failures: params.failures ?? [],
    } satisfies BackgroundResearchRecord,
  );
  params.context.background = merged;
}

export async function persistTerminology(params: {
  context: ValidatedPaperContext;
  entries: TerminologyEntry[];
}): Promise<void> {
  if (!params.entries.length) return;
  const key = `${params.context.identity.libraryID}:${params.context.identity.parentItemKey}`;
  const previous = terminologyWrites.get(key);
  const write = () => persistTerminologyNow(params);
  const current = previous ? previous.then(write, write) : write();
  terminologyWrites.set(key, current);
  try {
    await current;
  } finally {
    if (terminologyWrites.get(key) === current) terminologyWrites.delete(key);
  }
}

async function persistTerminologyNow(params: {
  context: ValidatedPaperContext;
  entries: TerminologyEntry[];
}): Promise<void> {
  const io = getIOUtils();
  const path = joinPath(params.context.paperDir, "terminology.md");
  let markdown = await readRequiredText(io, path);
  const existingSources = new Set(
    markdown
      .split("\n")
      .filter(
        (line) => line.startsWith("|") && !line.includes("Observed expression"),
      )
      .map((line) => line.split("|")[2]?.trim().toLocaleLowerCase())
      .filter(Boolean),
  );
  const now = new Date().toISOString();
  for (const entry of params.entries) {
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
  await writeText(io, path, markdown);
  params.context.terminology = markdown;
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

export async function setPreparationStage(params: {
  context: ValidatedPaperContext;
  id: PreparationStageId;
  status: PreparationStageStatus;
  detail?: string;
}): Promise<PreparationRecord> {
  const io = getIOUtils();
  const path = joinPath(params.context.paperDir, "_preparation.json");
  const current = await readPreparationRecord(params.context);
  const next = updatePreparationStages(current, [params]);
  await writePreparationRecord(io, path, next);
  return next;
}

export async function cleanupPermanentlyDeletedPaperContexts(): Promise<void> {
  const io = getIOUtils();
  const contextRoot = joinPath(resolveZoteroDataDir(), CONTEXT_ROOT_NAME);
  if (!(await io.exists(contextRoot))) return;
  for (const childPath of await io.getChildren(contextRoot)) {
    const sourcePath = joinPath(childPath, "_paper_source.json");
    if (!(await io.exists(sourcePath))) {
      throw new Error(
        `Context directory is missing _paper_source.json: ${childPath}`,
      );
    }
    const source = JSON.parse(
      await readRequiredText(io, sourcePath),
    ) as PaperSourceRecord;
    validateContextDeletionTarget(contextRoot, childPath, source);
    const liveItem = Zotero.Items.getByLibraryAndKey(
      source.libraryID,
      source.parentItemKey,
    );
    if (liveItem) continue;
    await io.remove(childPath, { recursive: true, ignoreAbsent: false });
  }
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
  if (!(await io.exists(sourcePath))) return null;
  const existing = JSON.parse(
    await readRequiredText(io, sourcePath),
  ) as Partial<PaperSourceRecord>;
  if (
    existing.parentItemKey !== expected.parentItemKey ||
    existing.libraryID !== expected.libraryID
  ) {
    throw new Error(`Paper context identity conflict: ${paperDir}`);
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
  const required = new Set<PreparationStageId>([
    "source",
    "index",
    "background",
    "terminology",
  ]);
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
  const terminal = new Set<PreparationStageStatus>([
    "complete",
    "warning",
    "error",
    "skipped",
  ]);
  const stages = record.stages.map((stage) => {
    const update = updateMap.get(stage.id);
    if (!update) return { ...stage };
    return {
      ...stage,
      status: update.status,
      startedAt:
        update.status === "pending" ? undefined : (stage.startedAt ?? now),
      completedAt: terminal.has(update.status)
        ? stage.status === update.status
          ? (stage.completedAt ?? now)
          : now
        : undefined,
      detail: update.detail?.trim() || undefined,
    };
  });
  const required = stages.filter((stage) => stage.required);
  const coreReady = required.every((stage) => stage.status === "complete");
  const external = stages.find((stage) => stage.id === "external");
  const overall = required.some((stage) => stage.status === "error")
    ? "error"
    : coreReady &&
        external &&
        ["complete", "warning", "skipped"].includes(external.status)
      ? "ready"
      : coreReady
        ? "core-ready"
        : "preparing";
  return { ...record, stages, overall, updatedAt: now };
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
  if (
    record.schemaVersion !== PAPER_CONTEXT_SCHEMA_VERSION ||
    record.parentItemKey !== parentItemKey ||
    record.fullMdSha256 !== fullMdSha256 ||
    !Array.isArray(record.stages) ||
    expectedIds.some(
      (id) =>
        !record.stages.some(
          (stage) =>
            stage.id === id && stage.file === PREPARATION_STAGE_FILES[id],
        ),
    )
  ) {
    throw new Error("Preparation record does not match the paper context");
  }
  return record;
}

async function writePreparationRecord(
  io: IOUtilsLike,
  path: string,
  record: PreparationRecord,
): Promise<void> {
  await writeJson(io, path, record);
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
      const observed = line.split("|")[1]?.trim().replace(/\\\|/g, "|");
      return !paperMarkdown || containsCaseInsensitive(paperMarkdown, observed);
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
    if (paperMarkdown && !containsCaseInsensitive(paperMarkdown, observed))
      continue;
    result += `| ${escapeMarkdownCell(observed)} | ${escapeMarkdownCell(observed)} | ${escapeMarkdownCell(translation)} | legacy | Migrated from schema v1 | ${escapeMarkdownCell(evidence || "legacy entry")} | paper | medium | ${escapeMarkdownCell(updatedAt || new Date().toISOString())} |\n`;
  }
  return result;
}

function hasTerminologyEntries(markdown: string): boolean {
  return markdown
    .split(/\r?\n/)
    .some(
      (line) =>
        line.startsWith("|") &&
        !line.includes("Observed expression") &&
        !/^\|\s*-/.test(line),
    );
}

function stageIsActiveOrFailed(
  record: PreparationRecord,
  id: PreparationStageId,
): boolean {
  const status = record.stages.find((stage) => stage.id === id)?.status;
  return status === "running" || status === "error";
}

function containsCaseInsensitive(value: string, needle: string): boolean {
  return (
    Boolean(needle) &&
    value.toLocaleLowerCase().includes(needle.toLocaleLowerCase())
  );
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
