import { config } from "../../package.json";

let readerInitializerRegistered = false;

const onRenderTextSelectionPopup: _ZoteroTypes.Reader.EventHandler<
  "renderTextSelectionPopup"
> = (event) => {
  addon.data.translate.selectedText = normalizeReaderAnnotationSelection(
    event.reader,
    event.params.annotation,
  );
  addon.hooks.onReaderPopupShow(event);
};

export function registerReaderInitializer() {
  if (readerInitializerRegistered) return;
  Zotero.Reader.registerEventListener(
    "renderTextSelectionPopup",
    onRenderTextSelectionPopup,
    config.addonID,
  );
  readerInitializerRegistered = true;
}

export function unregisterReaderInitializer(): void {
  if (!readerInitializerRegistered) return;
  Zotero.Reader.unregisterEventListener(
    "renderTextSelectionPopup",
    onRenderTextSelectionPopup,
  );
  readerInitializerRegistered = false;
}

const PARAGRAPH_MARKER = "\uE000";
const BULLET_PATTERN = "[•●▪◦‣]";
const MINIMUM_FLOAT_GAP = 12;
const FLOAT_GAP_LINE_HEIGHT_MULTIPLIER = 2;
const CROSS_PAGE_NOISE_PATTERNS = [
  /Authorized licensed use limited to:[^.\r\n]{1,240}\.\s*Downloaded on [^.\r\n]{1,360}?from IEEE Xplore\.\s*Restrictions apply\.?/giu,
  /Downloaded on [^.\r\n]{1,360}?from IEEE Xplore\.\s*Restrictions apply\.?/giu,
  /Authorized licensed use limited to:[^.\r\n]{1,240}\./giu,
  /Downloaded on [^.\r\n]{1,360}?from IEEE Xplore\.?/giu,
  /\b\d+[A-Z]-\d+\s+\d+\s+\d{4}\s+\d+(?:st|nd|rd|th)\s+[^|\r\n]{1,200}\([^)\r\n]{1,60}\)\s*\|/giu,
  /\|\s*DOI:\s*10\.\d{4,9}\/[-._;()/:A-Z0-9]+/giu,
  /97[89]-[\d-]+\/\d+\/\$[\d.]+\s*©\s*\d{4}\s*IEEE/giu,
];

export type ReaderSelectionLine = {
  text: string;
  rect: readonly [number, number, number, number];
};

export type ReaderSelectionLayout = {
  firstPageText: string;
  firstPageLines?: readonly ReaderSelectionLine[];
  nextPageText: string;
  nextPageLines: readonly ReaderSelectionLine[];
};

type ReaderTextAnnotation = {
  text: string;
  position?: {
    pageIndex?: unknown;
    rects?: unknown;
    nextPageRects?: unknown;
  };
};

export function normalizeReaderAnnotationSelection(
  reader: unknown,
  annotation: ReaderTextAnnotation,
): string {
  const layout = resolveReaderSelectionLayout(reader, annotation);
  if (!layout) return normalizeReaderSelection(annotation.text);
  return normalizeReaderSelection(annotation.text, layout);
}

export function normalizeReaderSelection(
  value: string,
  layout?: ReaderSelectionLayout,
): string {
  let text = removeVerifiedCrossPageArtifacts(value, layout)
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ");
  for (const pattern of CROSS_PAGE_NOISE_PATTERNS) {
    text = text.replace(pattern, " ");
  }
  text = text
    .split("\n")
    .filter((line) => !isStandalonePageArtifact(line))
    .join("\n")
    .replace(
      new RegExp(`(^|\\n)[\\t ]*(${BULLET_PATTERN})[\\t ]*`, "gmu"),
      (_match, _lineStart, bullet, offset) =>
        `${offset > 0 ? PARAGRAPH_MARKER : ""}${bullet} `,
    )
    .replace(/\n\s*\n+/g, PARAGRAPH_MARKER)
    .replace(/(\S)-[\t ]*\n[\t ]*(?=\p{Ll}{2})/gu, "$1-")
    .replace(/[\t ]*\n[\t ]*/g, " ")
    .replace(/[\t ]+/g, " ")
    .replace(new RegExp(`\\s*${PARAGRAPH_MARKER}\\s*`, "gu"), "\n")
    .replace(/ *\n */g, "\n")
    .trim();
  return text;
}

function removeVerifiedCrossPageArtifacts(
  value: string,
  layout: ReaderSelectionLayout | undefined,
): string {
  if (!layout) return value;
  const expected = `${layout.firstPageText} ${layout.nextPageText}`;
  if (value !== expected) return value;
  const firstPageText = removeTrailingArxivMarginLabel(
    layout.firstPageText,
    layout.firstPageLines,
  );
  const nextPageText = removeLeadingCrossPageObject(
    layout.nextPageText,
    layout.nextPageLines,
  );
  return `${firstPageText} ${nextPageText}`;
}

function removeTrailingArxivMarginLabel(
  value: string,
  lines: readonly ReaderSelectionLine[] | undefined,
): string {
  const lastLine = lines?.findLast(({ text }) => text.trim());
  if (!lastLine || !isRotatedArxivMarginLabel(lastLine)) return value;
  const label = lastLine.text.trim();
  if (!value.endsWith(label)) return value;
  const prefix = value.slice(0, -label.length);
  return /\s$/u.test(prefix) ? prefix.trimEnd() : value;
}

function isRotatedArxivMarginLabel(line: ReaderSelectionLine): boolean {
  const text = line.text.trim();
  if (
    !/^arXiv:\d{4}\.\d{4,5}(?:v\d+)?\s+\[[A-Za-z.-]+\]\s+\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}$/u.test(
      text,
    )
  ) {
    return false;
  }
  const width = Math.abs(line.rect[2] - line.rect[0]);
  const height = Math.abs(line.rect[3] - line.rect[1]);
  return width > 0 && height > width * 3;
}

function removeLeadingCrossPageObject(
  value: string,
  lines: readonly ReaderSelectionLine[],
): string {
  if (lines.length < 2) return value;
  const captionLineIndex = lines.findIndex(({ text }) =>
    isFloatingObjectCaptionLine(text),
  );
  if (
    captionLineIndex < 0 ||
    containsLeadingSemanticContent(lines.slice(0, captionLineIndex))
  ) {
    return value;
  }

  const lineHeight = median(lines.map(({ rect }) => rect[3] - rect[1]));
  if (!lineHeight) return value;
  const minimumGap = Math.max(
    MINIMUM_FLOAT_GAP,
    lineHeight * FLOAT_GAP_LINE_HEIGHT_MULTIPLIER,
  );
  let cutAfterLine = -1;
  for (let index = captionLineIndex; index < lines.length - 1; index += 1) {
    const upper = lines[index].rect;
    const lower = lines[index + 1].rect;
    const gap = upper[1] - lower[3];
    if (gap <= minimumGap) continue;
    const boundaryFollowsTrailingCaption =
      captionLineIndex > 0 &&
      (index === captionLineIndex ||
        isCompleteFloatingObjectCaptionBlock(
          lines.slice(captionLineIndex, index + 1),
        ));
    if (
      !boundaryFollowsTrailingCaption &&
      !startsSemanticProse(followingVisualBlock(lines, index + 1, minimumGap))
    ) {
      continue;
    }
    cutAfterLine = index;
    break;
  }
  if (
    cutAfterLine < 0 &&
    isCompleteSingleLineObjectHeading(lines[captionLineIndex].text) &&
    startsSemanticProse(lines.slice(captionLineIndex + 1, captionLineIndex + 2))
  ) {
    cutAfterLine = captionLineIndex;
  }
  if (cutAfterLine < 0) return value;

  const discardedPrefixEnd = matchExactLinePrefix(
    value,
    lines.slice(0, cutAfterLine + 1),
  );
  if (
    discardedPrefixEnd === undefined ||
    !/^\s/u.test(value.slice(discardedPrefixEnd))
  ) {
    return value;
  }
  const retainedText = value.slice(discardedPrefixEnd).trimStart();
  return retainedText || value;
}

function isCompleteFloatingObjectCaptionBlock(
  lines: readonly ReaderSelectionLine[],
): boolean {
  return isCompleteSingleLineObjectHeading(
    lines.map(({ text }) => text.trim()).join(" "),
  );
}

function followingVisualBlock(
  lines: readonly ReaderSelectionLine[],
  start: number,
  minimumGap: number,
): readonly ReaderSelectionLine[] {
  let end = start + 1;
  while (end < lines.length) {
    const upper = lines[end - 1].rect;
    const lower = lines[end].rect;
    if (upper[1] - lower[3] > minimumGap) break;
    end += 1;
  }
  return lines.slice(start, end);
}

function matchExactLinePrefix(
  value: string,
  lines: readonly ReaderSelectionLine[],
): number | undefined {
  let offset = 0;
  let matchedLine = false;
  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    if (matchedLine) {
      const separator = /^\s+/u.exec(value.slice(offset));
      if (!separator) return undefined;
      offset += separator[0].length;
    }
    if (!value.startsWith(text, offset)) return undefined;
    offset += text.length;
    matchedLine = true;
  }
  return matchedLine ? offset : undefined;
}

function containsLeadingSemanticContent(
  lines: readonly ReaderSelectionLine[],
): boolean {
  const firstContentIndex = lines.findIndex(({ text }) => text.trim());
  if (firstContentIndex < 0) return false;
  const block = [lines[firstContentIndex]];
  for (let index = firstContentIndex + 1; index < lines.length; index += 1) {
    if (!lines[index].text.trim()) continue;
    if (!areContinuousProseLines(block.at(-1)!, lines[index])) break;
    block.push(lines[index]);
  }
  return (
    block.some(({ text }) => isStructuredSemanticLine(text)) ||
    startsSemanticProse(block)
  );
}

function areContinuousProseLines(
  upper: ReaderSelectionLine,
  lower: ReaderSelectionLine,
): boolean {
  const upperHeight = Math.abs(upper.rect[3] - upper.rect[1]);
  const lowerHeight = Math.abs(lower.rect[3] - lower.rect[1]);
  const lineHeight = Math.max(upperHeight, lowerHeight);
  if (!lineHeight) return false;
  const maximumOffset = lineHeight * FLOAT_GAP_LINE_HEIGHT_MULTIPLIER;
  const verticalGap = upper.rect[1] - lower.rect[3];
  return (
    verticalGap >= -lineHeight &&
    verticalGap <= maximumOffset &&
    Math.abs(upper.rect[0] - lower.rect[0]) <= maximumOffset
  );
}

function isStructuredSemanticLine(value: string): boolean {
  return new RegExp(
    `^(?:${BULLET_PATTERN}|(?:[IVXLCDM]+|\\d+|[A-Z])\\.)\\s+\\S`,
    "u",
  ).test(value.trim());
}

function isCompleteSingleLineObjectHeading(value: string): boolean {
  const text = value.trim();
  return (
    /^(?:Fig\.|Figure)\s+\d+[A-Z]?\s*[.:]\s+\S.*[.!?]$/iu.test(text) ||
    isCompleteAlgorithmCaption(text)
  );
}

function isCompleteAlgorithmCaption(value: string): boolean {
  return (
    /^Algorithm\s+\d+[A-Z]?\s*[.:]\s+\S.*[.!?]$/iu.test(value) ||
    /^Algorithm\s+\d+[A-Z]?\s+\S.*\[\d+(?:\s*,\s*\d+)*\]\s*$/iu.test(value)
  );
}

function startsSemanticProse(lines: readonly ReaderSelectionLine[]): boolean {
  const content = lines.map((line) => line.text.trim()).filter(Boolean);
  if (!content.length || isFloatingObjectCaptionLine(content[0])) return false;
  const text = content.join(" ");
  return (
    /^[\p{L}\p{N}\p{Ps}\p{Pi}"']/u.test(text) &&
    /[.!?。！？](?:[\p{Pe}\p{Pf}"']*)\s*$/u.test(text)
  );
}

function isFloatingObjectCaptionLine(value: string): boolean {
  const text = value.trim();
  return (
    /^(?:Fig\.|Figure)\s+\d+[A-Z]?\s*[.:]\s+\S/iu.test(text) ||
    /^Algorithm\s+\d+[A-Z]?\s*[.:]\s+\S/iu.test(text) ||
    isCompleteAlgorithmCaption(text) ||
    /^TABLE\s+(?:[IVXLCDM]+|\d+)(?:\s|$)/u.test(text)
  );
}

function median(values: readonly number[]): number {
  const finite = values.filter((value) => Number.isFinite(value) && value > 0);
  if (!finite.length) return 0;
  const sorted = [...finite].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function resolveReaderSelectionLayout(
  reader: unknown,
  annotation: ReaderTextAnnotation,
): ReaderSelectionLayout | undefined {
  // Zotero flattens a two-page selection into annotation.text. Runtime ranges
  // are used only to prove page and line boundaries; exact identity checks keep
  // annotation.text as the sole translation input.
  const position = annotation.position;
  if (
    !Number.isInteger(position?.pageIndex) ||
    !isRectList(position?.rects) ||
    !isRectList(position?.nextPageRects)
  ) {
    return undefined;
  }
  const view = resolveCurrentReaderView(reader);
  const ranges = Array.isArray(view?._selectionRanges)
    ? [...view._selectionRanges].sort(
        (left, right) => Number(left?.pageIndex) - Number(right?.pageIndex),
      )
    : [];
  if (ranges.length !== 2) return undefined;
  const [firstRange, nextRange] = ranges;
  const firstPageIndex = Number(position.pageIndex);
  if (
    firstRange?.pageIndex !== firstPageIndex ||
    nextRange?.pageIndex !== firstPageIndex + 1 ||
    firstRange?.position?.pageIndex !== firstPageIndex ||
    nextRange?.position?.pageIndex !== firstPageIndex + 1 ||
    !sameRects(firstRange.position.rects, position.rects) ||
    !sameRects(nextRange.position.rects, position.nextPageRects) ||
    typeof firstRange.text !== "string" ||
    typeof nextRange.text !== "string" ||
    annotation.text !== `${firstRange.text} ${nextRange.text}`
  ) {
    return undefined;
  }
  const chars = view?._pdfPages?.[firstPageIndex + 1]?.chars;
  const nextPageLines = extractSelectedRuntimeLines(chars, nextRange);
  if (!nextPageLines) return undefined;
  const firstPageLines = extractSelectedRuntimeLines(
    view?._pdfPages?.[firstPageIndex]?.chars,
    firstRange,
  );
  return {
    firstPageText: firstRange.text,
    firstPageLines,
    nextPageText: nextRange.text,
    nextPageLines,
  };
}

function resolveCurrentReaderView(reader: unknown): any {
  const internal = (reader as any)?._internalReader;
  if (!internal) return undefined;
  return (
    internal._lastView ||
    (internal._lastViewPrimary === false
      ? internal._secondaryView
      : internal._primaryView)
  );
}

function extractSelectedRuntimeLines(
  chars: unknown,
  range: any,
): ReaderSelectionLine[] | undefined {
  if (
    !Array.isArray(chars) ||
    !Number.isInteger(range?.anchorOffset) ||
    !Number.isInteger(range?.headOffset) ||
    !isRectList(range?.position?.rects)
  ) {
    return undefined;
  }
  const from = Math.min(range.anchorOffset, range.headOffset);
  const to = Math.max(range.anchorOffset, range.headOffset);
  if (from < 0 || to > chars.length || from === to) return undefined;
  const selectedChars = chars.slice(from, to);
  if (runtimeCharsText(selectedChars) !== range.text) return undefined;

  const charLines: any[][] = [];
  let currentLine: any[] = [];
  for (const char of selectedChars) {
    if (!isRuntimeChar(char)) return undefined;
    currentLine.push(char);
    if (!char.lineBreakAfter) continue;
    charLines.push(currentLine);
    currentLine = [];
  }
  if (currentLine.length) charLines.push(currentLine);
  if (charLines.length !== range.position.rects.length) return undefined;
  return charLines.map((line, index) => ({
    text: runtimeCharsText(line),
    rect: range.position.rects[index],
  }));
}

function runtimeCharsText(chars: readonly any[]): string {
  const text: string[] = [];
  for (const char of chars) {
    if (!isRuntimeChar(char) || char.ignorable) continue;
    text.push(char.c);
    if (char.spaceAfter || char.lineBreakAfter) text.push(" ");
    if (char.paragraphBreakAfter) text.push(" ");
  }
  return text.join("").trim();
}

function isRuntimeChar(value: unknown): value is {
  c: string;
  ignorable?: boolean;
  spaceAfter?: boolean;
  lineBreakAfter?: boolean;
  paragraphBreakAfter?: boolean;
} {
  return (
    !!value && typeof value === "object" && typeof (value as any).c === "string"
  );
}

function isRectList(
  value: unknown,
): value is [number, number, number, number][] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (rect) =>
        Array.isArray(rect) &&
        rect.length === 4 &&
        rect.every((coordinate) => Number.isFinite(coordinate)),
    )
  );
}

function sameRects(left: unknown, right: unknown): boolean {
  return (
    isRectList(left) &&
    isRectList(right) &&
    left.length === right.length &&
    left.every((rect, index) =>
      rect.every((coordinate, axis) => coordinate === right[index][axis]),
    )
  );
}

function isStandalonePageArtifact(line: string): boolean {
  const value = line.trim();
  if (!value) return false;
  return (
    /^\d+[A-Z]-\d+(?:\s+\d+)?$/i.test(value) ||
    /^©\s*\d{4}\s+IEEE$/i.test(value)
  );
}
