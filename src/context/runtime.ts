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
  write(path: string, data: Uint8Array): Promise<unknown>;
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
};

export type TerminologyEntry = {
  source: string;
  translation: string;
  evidence: string;
};

export type BackgroundResearchRecord = {
  schemaVersion: typeof PAPER_CONTEXT_SCHEMA_VERSION;
  parentItemKey: string;
  fullMdSha256: string;
  status: "pending" | "complete" | "empty";
  researchedAt?: string;
  queries: string[];
  sources: BackgroundSource[];
};

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
  if (contentChanged) {
    await io.write(
      terminologyPath,
      textEncoder.encode(createTerminologyMarkdown(identity.title)),
    );
    await io.write(
      backgroundPath,
      textEncoder.encode(createBackgroundMarkdown(identity.title)),
    );
    await writeJson(io, backgroundSourcesPath, {
      schemaVersion: PAPER_CONTEXT_SCHEMA_VERSION,
      parentItemKey: identity.parentItemKey,
      fullMdSha256,
      status: "pending",
      queries: [],
      sources: [],
    } satisfies BackgroundResearchRecord);
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
  await ensureJsonFile(io, backgroundSourcesPath, {
    schemaVersion: PAPER_CONTEXT_SCHEMA_VERSION,
    parentItemKey: identity.parentItemKey,
    fullMdSha256,
    status: "pending",
    queries: [],
    sources: [],
  } satisfies BackgroundResearchRecord);

  const [terminology, background] = await Promise.all([
    readRequiredText(io, terminologyPath),
    readRequiredText(io, backgroundPath),
  ]);
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
    passages: retrievePassages(markdown, index, query),
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
  if (
    record.schemaVersion !== PAPER_CONTEXT_SCHEMA_VERSION ||
    record.parentItemKey !== context.identity.parentItemKey ||
    record.fullMdSha256 !== context.fullMdSha256 ||
    !Array.isArray(record.queries) ||
    !Array.isArray(record.sources)
  ) {
    throw new Error(
      "Background research record does not match the paper context",
    );
  }
  return record;
}

export async function persistBackgroundResearch(params: {
  context: ValidatedPaperContext;
  summary: string;
  queries: string[];
  sources: BackgroundSource[];
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
    };
  });
  await io.write(
    joinPath(params.context.paperDir, "background.md"),
    textEncoder.encode(
      [
        `# Background: ${params.context.identity.title || "Untitled paper"}`,
        "",
        summary,
        "",
      ].join("\n"),
    ),
  );
  await writeJson(
    io,
    joinPath(params.context.paperDir, "background-sources.json"),
    {
      schemaVersion: PAPER_CONTEXT_SCHEMA_VERSION,
      parentItemKey: params.context.identity.parentItemKey,
      fullMdSha256: params.context.fullMdSha256,
      status: sources.length > 0 ? "complete" : "empty",
      researchedAt: new Date().toISOString(),
      queries: params.queries.map((query) => query.trim()).filter(Boolean),
      sources,
    } satisfies BackgroundResearchRecord,
  );
  params.context.background = summary;
}

export async function persistTerminology(params: {
  context: ValidatedPaperContext;
  entries: TerminologyEntry[];
}): Promise<void> {
  if (!params.entries.length) return;
  const io = getIOUtils();
  const path = joinPath(params.context.paperDir, "terminology.md");
  let markdown = await readRequiredText(io, path);
  const existingSources = new Set(
    markdown
      .split("\n")
      .filter((line) => line.startsWith("|") && !line.includes("Source term"))
      .map((line) => line.split("|")[1]?.trim().toLocaleLowerCase())
      .filter(Boolean),
  );
  const now = new Date().toISOString();
  for (const entry of params.entries) {
    const source = entry.source.trim();
    const translation = entry.translation.trim();
    const evidence = entry.evidence.trim();
    if (!source || !translation || !evidence) {
      throw new Error("Terminology entry contains an empty field");
    }
    if (existingSources.has(source.toLocaleLowerCase())) continue;
    markdown += `| ${escapeMarkdownCell(source)} | ${escapeMarkdownCell(translation)} | ${escapeMarkdownCell(evidence)} | ${now} |\n`;
    existingSources.add(source.toLocaleLowerCase());
  }
  await io.write(path, textEncoder.encode(markdown));
  params.context.terminology = markdown;
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
  await io.write(
    path,
    textEncoder.encode(`${JSON.stringify(value, null, 2)}\n`),
  );
}

async function ensureJsonFile(io: IOUtilsLike, path: string, value: unknown) {
  if (!(await io.exists(path))) await writeJson(io, path, value);
}

async function ensureTextFile(io: IOUtilsLike, path: string, value: string) {
  if (!(await io.exists(path))) await io.write(path, textEncoder.encode(value));
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
