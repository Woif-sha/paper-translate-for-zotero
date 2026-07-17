export const PAPER_CONTEXT_SCHEMA_VERSION = 1;
export const MINERU_PROVENANCE_KIND = "llm-for-zotero/mineru-cache-source";
export const MINERU_PROVENANCE_VERSION = 2;

export type PaperIdentity = {
  libraryID: number;
  parentItemKey: string;
  attachmentID: number;
  attachmentKey: string;
  title: string;
  doi: string;
};

export type MineruProvenance = {
  kind: string;
  version: number;
  attachmentId: number;
  attachmentKey: string;
  parentItemKey: string;
  sourceFilename?: string;
  origin: "parsed" | "restored";
  recordedAt: string;
};

export type ManifestSection = {
  heading?: string;
  title?: string;
  charStart: number;
  charEnd: number;
};

export type MineruManifest = {
  sections?: ManifestSection[];
  totalChars?: number;
  noSections?: boolean;
};

export type PaperSourceRecord = PaperIdentity & {
  schemaVersion: typeof PAPER_CONTEXT_SCHEMA_VERSION;
  mineruCacheDir: string;
  fullMdPath: string;
  fullMdSha256: string;
  updatedAt: string;
};

export type PaperIndexChunk = {
  id: number;
  heading: string;
  charStart: number;
  charEnd: number;
};

export type PaperIndex = {
  schemaVersion: typeof PAPER_CONTEXT_SCHEMA_VERSION;
  parentItemKey: string;
  fullMdSha256: string;
  totalChars: number;
  chunks: PaperIndexChunk[];
  updatedAt: string;
};

export type RetrievedPassage = PaperIndexChunk & {
  text: string;
  score: number;
};

const MAX_CHUNK_CHARS = 1600;
const CHUNK_OVERLAP_CHARS = 160;

export function assertParentItemKey(value: string): void {
  if (!/^[A-Z0-9]{8}$/.test(value)) {
    throw new Error(`Invalid Zotero parent item key: ${value}`);
  }
}

export function parseAndValidateProvenance(
  raw: string,
  identity: PaperIdentity,
): MineruProvenance {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid MinerU provenance JSON: ${String(error)}`);
  }
  if (!value || typeof value !== "object") {
    throw new Error("MinerU provenance must be an object");
  }
  const source = value as Partial<MineruProvenance>;
  if (source.kind !== MINERU_PROVENANCE_KIND) {
    throw new Error(`Unsupported MinerU provenance kind: ${source.kind}`);
  }
  if (source.version !== MINERU_PROVENANCE_VERSION) {
    throw new Error(`Unsupported MinerU provenance version: ${source.version}`);
  }
  if (source.attachmentId !== identity.attachmentID) {
    throw new Error("MinerU attachmentId does not match the live attachment");
  }
  if (source.attachmentKey !== identity.attachmentKey) {
    throw new Error("MinerU attachmentKey does not match the live attachment");
  }
  if (source.parentItemKey !== identity.parentItemKey) {
    throw new Error("MinerU parentItemKey does not match the live parent item");
  }
  if (source.origin !== "parsed" && source.origin !== "restored") {
    throw new Error(`Unsupported MinerU provenance origin: ${source.origin}`);
  }
  if (!source.recordedAt) {
    throw new Error("MinerU provenance recordedAt is required");
  }
  return source as MineruProvenance;
}

export function parseAndValidateManifest(
  raw: string,
  markdown: string,
): MineruManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid MinerU manifest JSON: ${String(error)}`);
  }
  if (!value || typeof value !== "object") {
    throw new Error("MinerU manifest must be an object");
  }
  const manifest = value as MineruManifest;
  if (
    typeof manifest.totalChars === "number" &&
    manifest.totalChars !== markdown.length
  ) {
    throw new Error(
      `MinerU manifest totalChars ${manifest.totalChars} does not match full.md UTF-16 length ${markdown.length}`,
    );
  }
  for (const section of manifest.sections ?? []) {
    if (
      !Number.isInteger(section.charStart) ||
      !Number.isInteger(section.charEnd) ||
      section.charStart < 0 ||
      section.charEnd <= section.charStart ||
      section.charEnd > markdown.length
    ) {
      throw new Error(
        `MinerU manifest section range is invalid: ${section.charStart}-${section.charEnd}`,
      );
    }
  }
  return manifest;
}

export function buildPaperIndex(params: {
  parentItemKey: string;
  fullMdSha256: string;
  markdown: string;
  manifest: MineruManifest;
  updatedAt?: string;
}): PaperIndex {
  assertParentItemKey(params.parentItemKey);
  const ranges = normalizeSections(params.markdown, params.manifest);
  const chunks: PaperIndexChunk[] = [];
  for (const range of ranges) {
    let start = range.charStart;
    while (start < range.charEnd) {
      const end = Math.min(range.charEnd, start + MAX_CHUNK_CHARS);
      chunks.push({
        id: chunks.length,
        heading: range.heading,
        charStart: start,
        charEnd: end,
      });
      if (end === range.charEnd) break;
      start = Math.max(start + 1, end - CHUNK_OVERLAP_CHARS);
    }
  }
  return {
    schemaVersion: PAPER_CONTEXT_SCHEMA_VERSION,
    parentItemKey: params.parentItemKey,
    fullMdSha256: params.fullMdSha256,
    totalChars: params.markdown.length,
    chunks,
    updatedAt: params.updatedAt ?? new Date().toISOString(),
  };
}

export function retrievePassages(
  markdown: string,
  index: PaperIndex,
  query: string,
  limit = 6,
): RetrievedPassage[] {
  if (index.totalChars !== markdown.length) {
    throw new Error("Paper index length does not match full.md");
  }
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  return index.chunks
    .map((chunk) => {
      const text = markdown.slice(chunk.charStart, chunk.charEnd);
      const haystack = `${chunk.heading}\n${text}`.toLocaleLowerCase();
      const score = terms.reduce((total, term) => {
        let count = 0;
        let offset = 0;
        while ((offset = haystack.indexOf(term, offset)) >= 0) {
          count += 1;
          offset += term.length;
        }
        return total + Math.min(count, 8);
      }, 0);
      return { ...chunk, text, score };
    })
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score || a.charStart - b.charStart)
    .slice(0, limit);
}

export function createTerminologyMarkdown(title: string): string {
  return [
    `# Terminology: ${title || "Untitled paper"}`,
    "",
    "| Source term | Preferred translation | Section / evidence | Updated at |",
    "| --- | --- | --- | --- |",
    "",
  ].join("\n");
}

export function createBackgroundMarkdown(title: string): string {
  return [`# Background: ${title || "Untitled paper"}`, "", ""].join("\n");
}

function normalizeSections(
  markdown: string,
  manifest: MineruManifest,
): Array<{ heading: string; charStart: number; charEnd: number }> {
  const sections = manifest.sections ?? [];
  if (!manifest.noSections && sections.length > 0) {
    return sections.map((section) => ({
      heading: section.heading || section.title || "Paper",
      charStart: section.charStart,
      charEnd: section.charEnd,
    }));
  }
  return [{ heading: "Paper", charStart: 0, charEnd: markdown.length }];
}

function tokenize(value: string): string[] {
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  const words = normalized.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  const cjkRuns = normalized.match(/[\p{Script=Han}]{2,}/gu) ?? [];
  const bigrams = cjkRuns.flatMap((run) =>
    Array.from({ length: Math.max(0, run.length - 1) }, (_, index) =>
      run.slice(index, index + 2),
    ),
  );
  return [...new Set([...words, ...bigrams])].slice(0, 80);
}
