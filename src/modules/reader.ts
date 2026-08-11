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
  let text = removeLeadingCrossPageObject(value, layout)
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

function removeLeadingCrossPageObject(
  value: string,
  layout: ReaderSelectionLayout | undefined,
): string {
  if (!layout || layout.nextPageLines.length < 2) return value;
  const expected = `${layout.firstPageText} ${layout.nextPageText}`;
  if (value !== expected) return value;
  const firstLine = layout.nextPageLines.find(({ text }) => text.trim());
  if (!firstLine || !isFloatingObjectCaptionLine(firstLine.text)) return value;

  const lineHeight = median(
    layout.nextPageLines.map(({ rect }) => rect[3] - rect[1]),
  );
  if (!lineHeight) return value;
  const minimumGap = Math.max(
    MINIMUM_FLOAT_GAP,
    lineHeight * FLOAT_GAP_LINE_HEIGHT_MULTIPLIER,
  );
  let cutAfterLine = -1;
  for (let index = 0; index < layout.nextPageLines.length - 1; index += 1) {
    const upper = layout.nextPageLines[index].rect;
    const lower = layout.nextPageLines[index + 1].rect;
    const gap = upper[1] - lower[3];
    if (
      gap <= minimumGap ||
      !startsSemanticProse(layout.nextPageLines.slice(index + 1, index + 3))
    ) {
      continue;
    }
    cutAfterLine = index;
    break;
  }
  if (cutAfterLine < 0) return value;

  const discardedPrefix = layout.nextPageLines
    .slice(0, cutAfterLine + 1)
    .map(({ text }) => text.trim())
    .filter(Boolean)
    .join(" ");
  if (
    !discardedPrefix ||
    !layout.nextPageText.startsWith(discardedPrefix) ||
    !/^\s/u.test(layout.nextPageText.slice(discardedPrefix.length))
  ) {
    return value;
  }
  const retainedText = layout.nextPageText
    .slice(discardedPrefix.length)
    .trimStart();
  return retainedText ? `${layout.firstPageText} ${retainedText}` : value;
}

function startsSemanticProse(lines: readonly ReaderSelectionLine[]): boolean {
  const text = lines
    .map((line) => line.text.trim())
    .filter(Boolean)
    .join(" ");
  return (
    /^[\p{L}\p{N}\p{Ps}\p{Pi}"']/u.test(text) &&
    /[.!?。！？](?:[\p{Pe}\p{Pf}"']*)\s*$/u.test(text)
  );
}

function isFloatingObjectCaptionLine(value: string): boolean {
  const text = value.trim();
  return (
    /^(?:Fig\.|Figure)\s+\d+[A-Z]?\s*[.:]\s+\S/iu.test(text) ||
    /^Algorithm\s+\d+[A-Z]?\s+\S.*\[\d+(?:\s*,\s*\d+)*\]\s*$/iu.test(text) ||
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
  return {
    firstPageText: firstRange.text,
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
