export const PAPER_CONTEXT_SCHEMA_VERSION = 2;
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
  headingLevel: number;
  sectionIndex: number;
  charStart: number;
  charEnd: number;
  previousChunkId: number | null;
  nextChunkId: number | null;
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
const MIN_CHUNK_CHARS = 900;

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
  for (const [sectionIndex, range] of ranges.entries()) {
    for (const [start, end] of splitRangeAtParagraphs(
      params.markdown,
      range.charStart,
      range.charEnd,
    )) {
      chunks.push({
        id: chunks.length,
        heading: range.heading,
        headingLevel: range.headingLevel,
        sectionIndex,
        charStart: start,
        charEnd: end,
        previousChunkId: null,
        nextChunkId: null,
      });
    }
  }
  for (const [index, chunk] of chunks.entries()) {
    const previous = chunks[index - 1];
    const next = chunks[index + 1];
    chunk.previousChunkId =
      previous?.sectionIndex === chunk.sectionIndex ? previous.id : null;
    chunk.nextChunkId =
      next?.sectionIndex === chunk.sectionIndex ? next.id : null;
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
  const ranked = index.chunks
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
    .sort((a, b) => b.score - a.score || a.charStart - b.charStart);
  const selected = new Map<number, RetrievedPassage>();
  for (const passage of ranked) {
    if (selected.size >= limit) break;
    selected.set(passage.id, passage);
    for (const neighborId of [passage.previousChunkId, passage.nextChunkId]) {
      if (neighborId === null || selected.size >= limit) continue;
      const neighbor = index.chunks[neighborId];
      if (!neighbor || selected.has(neighbor.id)) continue;
      selected.set(neighbor.id, {
        ...neighbor,
        text: markdown.slice(neighbor.charStart, neighbor.charEnd),
        score: Math.max(0.1, passage.score * 0.25),
      });
    }
  }
  return [...selected.values()];
}

export function selectKnowledgePassages(
  markdown: string,
  index: PaperIndex,
  maxChars = 14_000,
): RetrievedPassage[] {
  const selected: RetrievedPassage[] = [];
  const seenSections = new Set<number>();
  let totalChars = 0;
  const priorities = [
    /abstract|摘要/i,
    /introduction|引言/i,
    /method|framework|proposed|方法|框架/i,
    /experiment|result|evaluation|实验|结果|评估/i,
    /conclusion|结论/i,
  ];
  const add = (chunk: PaperIndexChunk) => {
    if (seenSections.has(chunk.sectionIndex)) return;
    const text = markdown.slice(chunk.charStart, chunk.charEnd);
    if (selected.length && totalChars + text.length > maxChars) return;
    selected.push({ ...chunk, text, score: 1 });
    seenSections.add(chunk.sectionIndex);
    totalChars += text.length;
  };
  for (const pattern of priorities) {
    const chunk = index.chunks.find((candidate) =>
      pattern.test(candidate.heading),
    );
    if (chunk) add(chunk);
  }
  for (const chunk of index.chunks) add(chunk);
  return selected.sort((a, b) => a.charStart - b.charStart);
}

export function createTerminologyMarkdown(title: string): string {
  return [
    `# Terminology: ${title || "Untitled paper"}`,
    "",
    "| Observed expression | Canonical English | Preferred Chinese | Category | Definition | Paper evidence | Source level | Confidence | Updated at |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    "",
  ].join("\n");
}

export function createBackgroundMarkdown(title: string): string {
  return [`# Background: ${title || "Untitled paper"}`, "", ""].join("\n");
}

function normalizeSections(
  markdown: string,
  manifest: MineruManifest,
): Array<{
  heading: string;
  headingLevel: number;
  charStart: number;
  charEnd: number;
}> {
  const sections = manifest.sections ?? [];
  if (!manifest.noSections && sections.length > 0) {
    return sections.map((section) => ({
      heading: section.heading || section.title || "Paper",
      headingLevel: 1,
      charStart: section.charStart,
      charEnd: section.charEnd,
    }));
  }
  const markdownSections = extractMarkdownSections(markdown);
  if (markdownSections.length > 1) return markdownSections;
  return [
    {
      heading: markdownSections[0]?.heading || "Paper",
      headingLevel: markdownSections[0]?.headingLevel || 1,
      charStart: 0,
      charEnd: markdown.length,
    },
  ];
}

function extractMarkdownSections(markdown: string): Array<{
  heading: string;
  headingLevel: number;
  charStart: number;
  charEnd: number;
}> {
  const matches = [...markdown.matchAll(/^(#{1,4})[ \t]+(.+?)\s*$/gm)];
  if (!matches.length) return [];
  return matches.map((match, index) => ({
    heading: match[2].trim(),
    headingLevel: match[1].length,
    charStart: match.index ?? 0,
    charEnd: matches[index + 1]?.index ?? markdown.length,
  }));
}

function splitRangeAtParagraphs(
  markdown: string,
  charStart: number,
  charEnd: number,
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let start = charStart;
  while (start < charEnd) {
    const idealEnd = Math.min(charEnd, start + MAX_CHUNK_CHARS);
    if (idealEnd === charEnd) {
      ranges.push([start, charEnd]);
      break;
    }
    const searchFrom = Math.min(charEnd, start + MIN_CHUNK_CHARS);
    const window = markdown.slice(searchFrom, idealEnd);
    const paragraphMatches = [...window.matchAll(/\n\s*\n/g)];
    const lineBreak = window.lastIndexOf("\n");
    const boundary = paragraphMatches.length
      ? searchFrom + (paragraphMatches.at(-1)?.index ?? 0) + 2
      : lineBreak >= 0
        ? searchFrom + lineBreak + 1
        : idealEnd;
    const end = boundary > start ? boundary : idealEnd;
    ranges.push([start, end]);
    start = end;
  }
  return ranges;
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
