export const PAPER_CONTEXT_SCHEMA_VERSION = 3;
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
  manifestSha256: string;
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
  let previousEnd = 0;
  for (const [index, section] of (manifest.sections ?? []).entries()) {
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
    if (index > 0 && section.charStart < previousEnd) {
      throw new Error(
        `MinerU manifest sections are out of order or overlap at ${section.charStart}-${section.charEnd}`,
      );
    }
    previousEnd = section.charEnd;
  }
  return manifest;
}

export function buildPaperIndex(params: {
  parentItemKey: string;
  fullMdSha256: string;
  manifestSha256: string;
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
    manifestSha256: params.manifestSha256,
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

export function alignSelectionHyphens(
  input: string,
  paperMarkdown: string,
): string {
  return input.replace(
    /\b([\p{L}]+)-([\p{L}]+)\b/gu,
    (observed, prefix: string, suffix: string) => {
      if (paperMarkdown.includes(observed)) return observed;
      const joined = `${prefix}${suffix}`;
      return paperMarkdown.includes(joined) ? joined : observed;
    },
  );
}

export function selectKnowledgePassages(
  markdown: string,
  index: PaperIndex,
  maxChars = 8_000,
): RetrievedPassage[] {
  const selected: RetrievedPassage[] = [];
  const selectedChunks = new Set<number>();
  let totalChars = 0;
  const priorities: Array<RegExp | null> = [
    /abstract|摘要/i,
    /introduction|引言/i,
    /proposed|method|framework|methodology|overview|方法|框架/i,
    /parasitic.*(?:RC)?.*reduction|RC reduction|寄生.*缩减/i,
    /prediction accuracy|evaluation|\bresults?\b|^.*experiments?$|实验结果|评估/i,
    /conclusion|结论/i,
  ];
  const perPriorityBudget = Math.max(
    320,
    Math.floor(maxChars / priorities.length),
  );
  const add = (chunk: PaperIndexChunk, charBudget = perPriorityBudget) => {
    if (selectedChunks.has(chunk.id)) return;
    const remaining = maxChars - totalChars;
    if (remaining <= 0) return;
    const available = markdown.slice(chunk.charStart, chunk.charEnd);
    const text = clipKnowledgePassage(
      available,
      Math.min(charBudget, remaining),
    );
    if (!hasSubstantivePaperText(text)) return;
    selected.push({
      ...chunk,
      charEnd: chunk.charStart + text.length,
      text,
      score: 1,
    });
    selectedChunks.add(chunk.id);
    totalChars += text.length;
  };
  for (const [priorityIndex, pattern] of priorities.entries()) {
    const chunk =
      findPriorityKnowledgeChunk(
        markdown,
        index.chunks,
        pattern,
        selectedChunks,
        priorityIndex === 0 ? undefined : index.chunks[0]?.heading,
      ) ??
      (priorityIndex === 0
        ? findPriorityKnowledgeChunk(
            markdown,
            index.chunks,
            null,
            selectedChunks,
          )
        : undefined);
    if (chunk) add(chunk);
  }
  const remaining = index.chunks.filter((chunk) => {
    if (selectedChunks.has(chunk.id)) return false;
    if (/^references$|参考文献/i.test(chunk.heading.trim())) return false;
    return hasSubstantivePaperText(
      markdown.slice(chunk.charStart, chunk.charEnd),
    );
  });
  const step = Math.max(1, Math.ceil(remaining.length / 6));
  for (
    let remainingIndex = 0;
    remainingIndex < remaining.length && totalChars < maxChars;
    remainingIndex += step
  ) {
    add(remaining[remainingIndex], maxChars - totalChars);
  }
  return selected.sort((a, b) => a.charStart - b.charStart);
}

function findPriorityKnowledgeChunk(
  markdown: string,
  chunks: PaperIndexChunk[],
  pattern: RegExp | null,
  excludedChunks: Set<number>,
  excludedHeading?: string,
): PaperIndexChunk | undefined {
  for (const [anchorIndex, anchor] of chunks.entries()) {
    if (excludedChunks.has(anchor.id)) continue;
    if (excludedHeading && anchor.heading === excludedHeading) continue;
    if (pattern && !pattern.test(anchor.heading)) continue;
    const sectionEnd = Math.min(chunks.length, anchorIndex + 7);
    for (
      let chunkIndex = anchorIndex;
      chunkIndex < sectionEnd;
      chunkIndex += 1
    ) {
      const candidate = chunks[chunkIndex];
      if (candidate.sectionIndex !== anchor.sectionIndex) break;
      if (excludedChunks.has(candidate.id)) continue;
      if (
        hasSubstantivePaperText(
          markdown.slice(candidate.charStart, candidate.charEnd),
        )
      ) {
        return candidate;
      }
    }
    if (!pattern) return undefined;
  }
  return undefined;
}

function hasSubstantivePaperText(value: string): boolean {
  return value.replace(/^#{1,4}[^\n]*$/gm, "").trim().length >= 120;
}

function clipKnowledgePassage(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const window = value.slice(0, maxChars);
  const paragraphEnd = window.lastIndexOf("\n\n");
  const lineEnd = window.lastIndexOf("\n");
  const boundary =
    paragraphEnd >= Math.floor(maxChars * 0.6)
      ? paragraphEnd + 2
      : lineEnd >= Math.floor(maxChars * 0.75)
        ? lineEnd + 1
        : maxChars;
  return value.slice(0, boundary);
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
