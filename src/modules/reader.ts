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
  paragraphBreakAfter?: boolean;
};

type ReaderTextSelection = {
  text: string;
  // Exact text cuts must retain the corresponding lines before restoring breaks.
  lines: readonly ReaderSelectionLine[];
};

export type ReaderSelectionLayout = {
  firstPageText: string;
  firstPageLines?: readonly ReaderSelectionLine[];
  firstPageDocumentLines?: readonly ReaderSelectionLine[];
  nextPageText: string;
  nextPageLines: readonly ReaderSelectionLine[];
  nextPageDocumentLines?: readonly ReaderSelectionLine[];
};

type ReaderTextAnnotation = {
  text: string;
  position?: {
    pageIndex?: unknown;
    rects?: unknown;
    nextPageRects?: unknown;
  };
};

type ResolvedReaderSelectionLayout =
  | {
      kind: "singlePage";
      text: string;
      lines: readonly ReaderSelectionLine[];
      documentLines?: readonly ReaderSelectionLine[];
    }
  | ({ kind: "crossPage" } & ReaderSelectionLayout);

export function normalizeReaderAnnotationSelection(
  reader: unknown,
  annotation: ReaderTextAnnotation,
): string {
  const layout = resolveReaderSelectionLayout(reader, annotation);
  if (!layout) return normalizeReaderSelection(annotation.text);
  if (layout.kind === "singlePage") {
    return normalizeReaderSelection(
      restoreReaderSemanticBoundaries(
        removeEmbeddedCrossColumnObject(
          { text: layout.text, lines: layout.lines },
          layout.documentLines,
        ),
      ),
    );
  }
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
  const firstPage = removeTrailingArxivMarginLabel(
    removeTrailingRepeatedPageFurniture(
      { text: layout.firstPageText, lines: layout.firstPageLines ?? [] },
      layout.firstPageDocumentLines,
      layout.nextPageDocumentLines,
    ),
  );
  const nextPage = removeLeadingCrossPageArtifact(
    { text: layout.nextPageText, lines: layout.nextPageLines },
    layout.firstPageLines,
    layout.nextPageDocumentLines,
  );
  return restoreReaderSemanticBoundaries({
    text: `${firstPage.text} ${nextPage.text}`,
    lines: [...firstPage.lines, ...nextPage.lines],
  });
}

function removeTrailingRepeatedPageFurniture(
  selection: ReaderTextSelection,
  firstPageDocumentLines: readonly ReaderSelectionLine[] | undefined,
  nextPageDocumentLines: readonly ReaderSelectionLine[] | undefined,
): ReaderTextSelection {
  const { text: value, lines } = selection;
  const contentLines = lines.filter(({ text }) => text.trim());
  if (
    contentLines.length < 2 ||
    !firstPageDocumentLines?.length ||
    !nextPageDocumentLines?.length
  ) {
    return selection;
  }
  let furnitureStart = contentLines.length;
  for (let index = contentLines.length - 1; index > 0; index -= 1) {
    if (
      !isRepeatedPageBoundaryLine(
        contentLines[index],
        firstPageDocumentLines,
        nextPageDocumentLines,
      )
    ) {
      break;
    }
    furnitureStart = index;
  }
  if (furnitureStart === contentLines.length) return selection;

  const retainedEnd = matchExactLinePrefix(
    value,
    contentLines.slice(0, furnitureStart),
  );
  const fullEnd = matchExactLinePrefix(value, contentLines);
  if (
    retainedEnd === undefined ||
    fullEnd !== value.length ||
    !/^\s/u.test(value.slice(retainedEnd))
  ) {
    return selection;
  }
  return {
    text: value.slice(0, retainedEnd).trimEnd(),
    lines: contentLines.slice(0, furnitureStart),
  };
}

function isRepeatedPageBoundaryLine(
  candidate: ReaderSelectionLine,
  firstPageLines: readonly ReaderSelectionLine[],
  nextPageLines: readonly ReaderSelectionLine[],
): boolean {
  if (!isPageBoundaryLine(candidate, firstPageLines)) return false;
  const contentLines = nextPageLines.filter(({ text }) => text.trim());
  if (contentLines.length < 2) return false;

  const candidateText = candidate.text.trim();
  const candidateHeight = Math.abs(candidate.rect[3] - candidate.rect[1]);
  const candidateCenter = (candidate.rect[1] + candidate.rect[3]) / 2;
  return contentLines.some((line) => {
    const height = Math.abs(line.rect[3] - line.rect[1]);
    const center = (line.rect[1] + line.rect[3]) / 2;
    return (
      line.text.trim() === candidateText &&
      candidateHeight > 0 &&
      height > 0 &&
      Math.abs(candidateHeight - height) <=
        Math.max(candidateHeight * 0.08, 0.25) &&
      Math.abs(candidateCenter - center) <= Math.max(candidateHeight, height) &&
      isPageBoundaryLine(line, nextPageLines)
    );
  });
}

function isPageBoundaryLine(
  candidate: ReaderSelectionLine,
  pageLines: readonly ReaderSelectionLine[],
): boolean {
  const bounds = pageVerticalBounds(pageLines);
  if (!bounds) return false;
  const center = (candidate.rect[1] + candidate.rect[3]) / 2;
  const boundaryBand = (bounds.top - bounds.bottom) * 0.12;
  return (
    center <= bounds.bottom + boundaryBand ||
    center >= bounds.top - boundaryBand
  );
}

function isPageBottomLine(
  candidate: ReaderSelectionLine,
  pageLines: readonly ReaderSelectionLine[],
): boolean {
  const bounds = pageVerticalBounds(pageLines);
  if (!bounds) return false;
  const center = (candidate.rect[1] + candidate.rect[3]) / 2;
  return center <= bounds.bottom + (bounds.top - bounds.bottom) * 0.12;
}

function pageVerticalBounds(
  pageLines: readonly ReaderSelectionLine[],
): { bottom: number; top: number } | undefined {
  const contentLines = pageLines.filter(({ text }) => text.trim());
  if (contentLines.length < 2) return undefined;
  const bottom = Math.min(...contentLines.map(({ rect }) => rect[1]));
  const top = Math.max(...contentLines.map(({ rect }) => rect[3]));
  return top > bottom ? { bottom, top } : undefined;
}

function removeTrailingArxivMarginLabel(
  selection: ReaderTextSelection,
): ReaderTextSelection {
  const { text: value, lines } = selection;
  const lastLine = lines.findLast(({ text }) => text.trim());
  if (!lastLine || !isRotatedArxivMarginLabel(lastLine)) return selection;
  const label = lastLine.text.trim();
  if (!value.endsWith(label)) return selection;
  const prefix = value.slice(0, -label.length);
  return /\s$/u.test(prefix)
    ? {
        text: prefix.trimEnd(),
        lines: lines.slice(0, lines.indexOf(lastLine)),
      }
    : selection;
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

function removeLeadingCrossPageArtifact(
  selection: ReaderTextSelection,
  firstPageLines: readonly ReaderSelectionLine[] | undefined,
  nextPageDocumentLines: readonly ReaderSelectionLine[] | undefined,
): ReaderTextSelection {
  const lines = selection.lines;
  const furnitureEnd = findLeadingCrossPageFurnitureEnd(
    lines,
    firstPageLines,
    nextPageDocumentLines,
  );
  if (furnitureEnd >= 0) {
    return removeExactLeadingLines(selection, furnitureEnd);
  }
  return removeLeadingCrossPageObject(selection, firstPageLines);
}

function findLeadingCrossPageFurnitureEnd(
  lines: readonly ReaderSelectionLine[],
  firstPageLines: readonly ReaderSelectionLine[] | undefined,
  nextPageDocumentLines: readonly ReaderSelectionLine[] | undefined,
): number {
  const previous = firstPageLines?.findLast(({ text }) => text.trim());
  if (!previous || !nextPageDocumentLines?.length || lines.length < 2) {
    return -1;
  }
  for (let index = 0; index < lines.length - 1; index += 1) {
    const upper = lines[index];
    const lower = lines[index + 1];
    const upperHeight = lineHeight(upper);
    const lowerHeight = lineHeight(lower);
    const minimumGap = Math.max(
      MINIMUM_FLOAT_GAP,
      Math.min(upperHeight, lowerHeight),
    );
    if (
      !upperHeight ||
      !lowerHeight ||
      upper.rect[1] - lower.rect[3] < minimumGap ||
      !lines
        .slice(0, index + 1)
        .every((line) => isPageTopLine(line, nextPageDocumentLines)) ||
      !startsVerifiedCrossPageBodyBlock(
        firstPageLines,
        lines.slice(index + 1),
      ) ||
      !continuesSemanticText(previous.text, lower.text)
    ) {
      continue;
    }
    return index;
  }
  return -1;
}

function isPageTopLine(
  candidate: ReaderSelectionLine,
  pageLines: readonly ReaderSelectionLine[],
): boolean {
  const bounds = pageVerticalBounds(pageLines);
  if (!bounds) return false;
  const center = (candidate.rect[1] + candidate.rect[3]) / 2;
  return center >= bounds.top - (bounds.top - bounds.bottom) * 0.12;
}

function continuesSemanticText(previous: string, next: string): boolean {
  const previousText = previous.trim();
  const nextText = next.trim();
  return (
    !!previousText &&
    !/[.!?。！？](?:[\p{Pe}\p{Pf}"']*)\s*$/u.test(previousText) &&
    /^\p{Ll}/u.test(nextText)
  );
}

function removeLeadingCrossPageObject(
  selection: ReaderTextSelection,
  firstPageLines: readonly ReaderSelectionLine[] | undefined,
): ReaderTextSelection {
  const lines = selection.lines;
  if (lines.length < 2) return selection;
  const captionLineIndex = findLastConsecutiveCaptionBlockStart(lines);
  if (
    captionLineIndex < 0 ||
    containsLeadingSemanticContent(lines.slice(0, captionLineIndex))
  ) {
    return selection;
  }

  const lineHeight = median(lines.map(({ rect }) => rect[3] - rect[1]));
  if (!lineHeight) return selection;
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
    const followingBlock = followingVisualBlock(lines, index + 1, minimumGap);
    if (
      !boundaryFollowsTrailingCaption &&
      !startsSemanticProse(followingBlock) &&
      !startsVerifiedCrossPageBodyBlock(firstPageLines, followingBlock)
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
  if (cutAfterLine < 0) return selection;

  return removeExactLeadingLines(selection, cutAfterLine);
}

function removeExactLeadingLines(
  selection: ReaderTextSelection,
  end: number,
): ReaderTextSelection {
  const { text: value } = selection;
  const lines = selection.lines;
  const discardedPrefixEnd = matchExactLinePrefix(
    value,
    lines.slice(0, end + 1),
  );
  if (
    discardedPrefixEnd === undefined ||
    !/^\s/u.test(value.slice(discardedPrefixEnd))
  ) {
    return selection;
  }
  const retainedText = value.slice(discardedPrefixEnd).trimStart();
  return retainedText
    ? { text: retainedText, lines: lines.slice(end + 1) }
    : selection;
}

function startsVerifiedCrossPageBodyBlock(
  firstPageLines: readonly ReaderSelectionLine[] | undefined,
  lines: readonly ReaderSelectionLine[],
): boolean {
  const previous = firstPageLines?.findLast(({ text }) => text.trim());
  const first = lines.find(({ text }) => text.trim());
  if (!previous || !first || isFloatingObjectCaptionLine(first.text)) {
    return false;
  }
  const previousHeight = Math.abs(previous.rect[3] - previous.rect[1]);
  const firstHeight = Math.abs(first.rect[3] - first.rect[1]);
  if (
    !previousHeight ||
    !firstHeight ||
    Math.abs(previousHeight - firstHeight) >
      Math.max(previousHeight * 0.08, 0.25)
  ) {
    return false;
  }
  return true;
}

function removeEmbeddedCrossColumnObject(
  selection: ReaderTextSelection,
  documentLines?: readonly ReaderSelectionLine[],
): ReaderTextSelection {
  const lines = selection.lines;
  if (lines.length < 3) return selection;
  const lineHeight = median(
    lines.map(({ rect }) => Math.abs(rect[3] - rect[1])),
  );
  if (!lineHeight) return selection;
  const minimumGap = Math.max(
    MINIMUM_FLOAT_GAP,
    lineHeight * FLOAT_GAP_LINE_HEIGHT_MULTIPLIER,
  );

  for (let start = 1; start < lines.length; start += 1) {
    if (!isForwardColumnWrap(lines[start - 1], lines[start], minimumGap)) {
      continue;
    }
    const footnoteStart = findVerifiedFootnoteStart(
      lines.slice(0, start),
      documentLines,
    );
    const columnLines = lines.slice(start);
    const captionStart = findLastConsecutiveCaptionBlockStart(columnLines);
    if (captionStart < 0) {
      if (footnoteStart < 0) continue;
      return removeExactLineRange(selection, footnoteStart, start - 1);
    }
    const leadingLines = columnLines.slice(0, captionStart);
    const captionEnd = findCaptionBlockEnd(
      columnLines,
      captionStart,
      columnLines.length,
    );
    const objectEnd = findObjectEndAfterCaption(
      columnLines,
      captionEnd,
      minimumGap,
    );
    if (objectEnd < captionEnd || objectEnd >= columnLines.length - 1) {
      if (footnoteStart < 0) continue;
      return removeExactLineRange(selection, footnoteStart, start - 1);
    }
    if (
      containsLeadingSemanticContent(leadingLines) ||
      formsAlignedProseContinuation(
        lines[(footnoteStart >= 0 ? footnoteStart : start) - 1],
        leadingLines,
        columnLines[objectEnd + 1],
        minimumGap,
      )
    ) {
      if (footnoteStart < 0) continue;
      return removeExactLineRange(selection, footnoteStart, start - 1);
    }

    const absoluteEnd = start + objectEnd;
    return removeExactLineRange(
      selection,
      footnoteStart >= 0 ? footnoteStart : start,
      absoluteEnd,
    );
  }
  return selection;
}

function findVerifiedFootnoteStart(
  lines: readonly ReaderSelectionLine[],
  documentLines: readonly ReaderSelectionLine[] | undefined,
): number {
  if (lines.length < 2 || !documentLines?.length) return -1;
  for (let start = 1; start < lines.length; start += 1) {
    const previous = lines[start - 1];
    const previousHeight = lineHeight(previous);
    const footnoteLines = lines.slice(start);
    if (
      !previousHeight ||
      !isPageBottomLine(footnoteLines.at(-1)!, documentLines) ||
      !hasDistinctBlockSeparation(previous, footnoteLines) ||
      footnoteLines.some(
        (line) =>
          !line.text.trim() ||
          !lineHeight(line) ||
          lineHeight(line) >= previousHeight * 0.9,
      ) ||
      footnoteLines.some(
        (line, index) =>
          index > 0 &&
          !areContinuousFootnoteLines(
            footnoteLines[index - 1],
            line,
            previousHeight,
          ),
      )
    ) {
      continue;
    }
    return start;
  }
  return -1;
}

function hasDistinctBlockSeparation(
  previous: ReaderSelectionLine,
  block: readonly ReaderSelectionLine[],
): boolean {
  if (block.length < 2) return false;
  const separation = previous.rect[1] - block[0].rect[3];
  const blockLineHeight = median(block.map(lineHeight));
  const internalGap = median(
    block
      .slice(1)
      .map((line, index) => Math.max(0, block[index].rect[1] - line.rect[3])),
  );
  return separation >= blockLineHeight && separation >= internalGap * 2;
}

function areContinuousFootnoteLines(
  upper: ReaderSelectionLine,
  lower: ReaderSelectionLine,
  bodyLineHeight: number,
): boolean {
  const maximumOffset = bodyLineHeight * 2;
  const verticalGap = upper.rect[1] - lower.rect[3];
  return (
    verticalGap >= -bodyLineHeight &&
    verticalGap <= maximumOffset &&
    Math.abs(upper.rect[0] - lower.rect[0]) <= maximumOffset
  );
}

function lineHeight(line: ReaderSelectionLine): number {
  return Math.abs(line.rect[3] - line.rect[1]);
}

function removeExactLineRange(
  selection: ReaderTextSelection,
  start: number,
  end: number,
): ReaderTextSelection {
  const { text: value } = selection;
  const lines = selection.lines;
  const retainedPrefixEnd = matchExactLinePrefix(value, lines.slice(0, start));
  const discardedBlockEnd = matchExactLinePrefix(
    value,
    lines.slice(0, end + 1),
  );
  if (
    retainedPrefixEnd === undefined ||
    discardedBlockEnd === undefined ||
    !/^\s/u.test(value.slice(retainedPrefixEnd)) ||
    !/^\s/u.test(value.slice(discardedBlockEnd))
  ) {
    return selection;
  }
  return {
    text: `${value.slice(0, retainedPrefixEnd).trimEnd()} ${value
      .slice(discardedBlockEnd)
      .trimStart()}`,
    lines: [...lines.slice(0, start), ...lines.slice(end + 1)],
  };
}

function restoreReaderSemanticBoundaries(
  selection: ReaderTextSelection,
): string {
  const { text, lines } = selection;
  if (!lines.length) return text;
  // Keep offsets stable while removing furniture and its paragraph metadata.
  const retainedText = text.split("");
  for (const pattern of CROSS_PAGE_NOISE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      retainedText.fill(" ", match.index, match.index + match[0].length);
    }
  }
  const retainedLines: (ReaderSelectionLine & { offset: number })[] = [];
  let offset = 0;
  for (const line of lines) {
    const lineText = line.text.trim();
    if (!lineText) continue;
    offset += /^\s*/u.exec(text.slice(offset))![0].length;
    if (!text.startsWith(lineText, offset)) return text;
    const start = offset;
    offset += lineText.length;
    if (isStandalonePageArtifact(lineText)) {
      retainedText.fill(" ", start, offset);
    }
    const retainedLine = retainedText.slice(start, offset).join("");
    if (!retainedLine.trim()) continue;
    retainedLines.push({
      ...line,
      text: retainedLine.trim(),
      offset: start + retainedLine.search(/\S/u),
      paragraphBreakAfter:
        line.paragraphBreakAfter && retainedText[offset - 1] !== " ",
    });
  }
  if (offset !== text.trimEnd().length) return text;

  const listStarts = verifiedReaderListStarts(retainedLines);
  const boundaries: number[] = [];
  for (let index = 1; index < retainedLines.length; index += 1) {
    if (retainedLines[index - 1].paragraphBreakAfter || listStarts.has(index)) {
      boundaries.push(retainedLines[index].offset);
    }
  }
  let restored = retainedText.join("");
  for (const boundary of boundaries.reverse()) {
    restored = `${restored.slice(0, boundary)}${PARAGRAPH_MARKER}${restored.slice(boundary)}`;
  }
  return restored;
}

function verifiedReaderListStarts(
  lines: readonly ReaderSelectionLine[],
): Set<number> {
  const starts = new Set<number>();
  const levels: {
    marker: string;
    index: number;
    anchored: boolean;
    descendants: number[];
  }[] = [];
  for (const [index, line] of lines.entries()) {
    const paragraphStart = index === 0 || lines[index - 1].paragraphBreakAfter;
    if (paragraphStart) levels.length = 0;
    const marker = readerListMarker(line.text);
    if (!marker) continue;
    // Sequence evidence survives a column or page changing the coordinates.
    const sequencePredecessors = levels.filter(
      (candidate) =>
        candidate.anchored &&
        areConsecutiveListMarkers(candidate.marker, marker),
    );
    while (
      levels.length > 1 &&
      line.rect[0] < lines[levels[levels.length - 1].index].rect[0]
    ) {
      levels.pop();
    }
    const previous = levels.at(-1);
    const nested = Boolean(
      previous && line.rect[0] > lines[previous.index].rect[0],
    );
    const parents = nested ? levels : levels.slice(0, -1);
    const parent = parents.at(-1);
    // A lexical sequence needs a known start; only adjacent confirmed items
    // or an anchored parent can anchor another list style.
    let anchored = Boolean(
      paragraphStart ||
      parent?.anchored ||
      (previous?.index === index - 1 && starts.has(previous.index)),
    );
    if (parent?.anchored) {
      for (const ancestor of parents) ancestor.descendants.push(index);
      if (starts.has(parent.index)) starts.add(index);
    }
    if (sequencePredecessors.length) {
      starts.add(index);
      for (const candidate of sequencePredecessors) {
        starts.add(candidate.index);
        // Parent confirmation also covers recorded single subitems.
        for (const descendant of candidate.descendants) starts.add(descendant);
      }
      anchored = true;
    }
    const current = { marker, index, anchored, descendants: [] };
    if (nested || !levels.length) levels.push(current);
    else levels[levels.length - 1] = current;
  }
  return starts;
}

function areConsecutiveListMarkers(previous: string, next: string): boolean {
  if (new RegExp(`^${BULLET_PATTERN}$`, "u").test(previous)) {
    return new RegExp(`^${BULLET_PATTERN}$`, "u").test(next);
  }
  if (/^\d+\.$/u.test(previous) && /^\d+\.$/u.test(next)) {
    return Number(next.slice(0, -1)) === Number(previous.slice(0, -1)) + 1;
  }
  if (/^[A-Z]\.$/u.test(previous) && /^[A-Z]\.$/u.test(next)) {
    if (next.charCodeAt(0) === previous.charCodeAt(0) + 1) return true;
  }
  if (/^[IVXLCDM]+\.$/u.test(previous) && /^[IVXLCDM]+\.$/u.test(next)) {
    return romanListOrdinal(next) === romanListOrdinal(previous) + 1;
  }
  return false;
}

function romanListOrdinal(marker: string): number {
  const values: Record<string, number> = {
    I: 1,
    V: 5,
    X: 10,
    L: 50,
    C: 100,
    D: 500,
    M: 1_000,
  };
  let ordinal = 0;
  for (let index = 0; index < marker.length - 1; index += 1) {
    const value = values[marker[index]];
    ordinal += value < values[marker[index + 1]] ? -value : value;
  }
  return ordinal;
}

function formsAlignedProseContinuation(
  previousColumnLine: ReaderSelectionLine,
  leadingLines: readonly ReaderSelectionLine[],
  followingLine: ReaderSelectionLine,
  maximumOffset: number,
): boolean {
  const first = leadingLines.find(({ text }) => text.trim());
  if (
    !first ||
    Math.abs(first.rect[0] - followingLine.rect[0]) > maximumOffset
  ) {
    return false;
  }
  const text = first.text.trim();
  if (
    /^(?:for|if|while|return|exit|continue|barrier)\b/iu.test(text) ||
    /[=;{}]|(?:->|→)/u.test(text)
  ) {
    return false;
  }
  return (
    /^\p{Ll}/u.test(text) ||
    /[.!?。！？](?:[\p{Pe}\p{Pf}"']*)\s*$/u.test(previousColumnLine.text.trim())
  );
}

function isForwardColumnWrap(
  previous: ReaderSelectionLine,
  next: ReaderSelectionLine,
  minimumGap: number,
): boolean {
  return (
    next.rect[0] - previous.rect[0] > minimumGap &&
    next.rect[1] - previous.rect[3] > minimumGap
  );
}

function findObjectEndAfterCaption(
  lines: readonly ReaderSelectionLine[],
  captionEnd: number,
  minimumGap: number,
): number {
  for (let index = captionEnd; index < lines.length - 1; index += 1) {
    if (lines[index].rect[1] - lines[index + 1].rect[3] > minimumGap) {
      return index;
    }
  }
  return -1;
}

function findLastConsecutiveCaptionBlockStart(
  lines: readonly ReaderSelectionLine[],
): number {
  const starts = lines.flatMap(({ text }, index) =>
    isFloatingObjectCaptionLine(text) ? [index] : [],
  );
  if (!starts.length) return -1;

  let candidateStart = starts[0];
  let candidateEnd = findCaptionBlockEnd(
    lines,
    candidateStart,
    starts[1] ?? lines.length,
  );
  for (let index = 1; index < starts.length; index += 1) {
    const nextStart = starts[index];
    if (
      containsLeadingSemanticContent(lines.slice(candidateEnd + 1, nextStart))
    ) {
      break;
    }
    candidateStart = nextStart;
    candidateEnd = findCaptionBlockEnd(
      lines,
      candidateStart,
      starts[index + 1] ?? lines.length,
    );
  }
  return candidateStart;
}

function findCaptionBlockEnd(
  lines: readonly ReaderSelectionLine[],
  start: number,
  end: number,
): number {
  for (let index = start; index < end; index += 1) {
    if (isCompleteFloatingObjectCaptionBlock(lines.slice(start, index + 1))) {
      return index;
    }
  }
  return start;
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
    if (matchedLine && !value.startsWith(text, offset)) {
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
  return Boolean(readerListMarker(value));
}

function readerListMarker(value: string): string | undefined {
  return new RegExp(
    `^(${BULLET_PATTERN}|(?:[IVXLCDM]+|\\d+|[A-Z])\\.)\\s+\\S`,
    "u",
  ).exec(value.trim())?.[1];
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
    /^TABLE\s+(?:[IVXLCDM]+|\d+)(?:\s|$)/u.test(text) ||
    /^Table\s+(?:[IVXLCDM]+|\d+)(?:\s*$|\s*[.:]\s+\S)/u.test(text)
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
): ResolvedReaderSelectionLayout | undefined {
  // Zotero flattens a selection into annotation.text. Runtime ranges are used
  // only to prove page and line boundaries; exact identity checks keep
  // annotation.text as the sole translation input.
  const position = annotation.position;
  if (!Number.isInteger(position?.pageIndex) || !isRectList(position?.rects)) {
    return undefined;
  }
  const view = resolveCurrentReaderView(reader);
  const ranges = Array.isArray(view?._selectionRanges)
    ? [...view._selectionRanges].sort(
        (left, right) => Number(left?.pageIndex) - Number(right?.pageIndex),
      )
    : [];
  const firstPageIndex = Number(position.pageIndex);
  if (ranges.length === 1) {
    const [range] = ranges;
    if (
      range?.pageIndex !== firstPageIndex ||
      range?.position?.pageIndex !== firstPageIndex ||
      !sameRects(range.position.rects, position.rects) ||
      typeof range.text !== "string" ||
      annotation.text !== range.text
    ) {
      return undefined;
    }
    const chars = view?._pdfPages?.[firstPageIndex]?.chars;
    const lines = extractSelectedRuntimeLines(chars, range);
    return lines
      ? {
          kind: "singlePage",
          text: range.text,
          lines,
          documentLines: extractRuntimePageLines(chars),
        }
      : undefined;
  }
  if (ranges.length !== 2 || !isRectList(position.nextPageRects)) {
    return undefined;
  }
  const [firstRange, nextRange] = ranges;
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
  const nextPageDocumentLines = extractRuntimePageLines(chars);
  const firstPageChars = view?._pdfPages?.[firstPageIndex]?.chars;
  const firstPageLines = extractSelectedRuntimeLines(
    firstPageChars,
    firstRange,
  );
  const firstPageDocumentLines = extractRuntimePageLines(firstPageChars);
  return {
    kind: "crossPage",
    firstPageText: firstRange.text,
    firstPageLines,
    firstPageDocumentLines,
    nextPageText: nextRange.text,
    nextPageLines,
    nextPageDocumentLines,
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
    paragraphBreakAfter: line.some((char) => char.paragraphBreakAfter),
  }));
}

function extractRuntimePageLines(
  chars: unknown,
): ReaderSelectionLine[] | undefined {
  if (!Array.isArray(chars) || !chars.length) return undefined;
  const lines: ReaderSelectionLine[] = [];
  let currentLine: any[] = [];
  for (const char of chars) {
    if (!isRuntimePageChar(char)) return undefined;
    currentLine.push(char);
    if (!char.lineBreakAfter) continue;
    lines.push(runtimePageLine(currentLine));
    currentLine = [];
  }
  if (currentLine.length) lines.push(runtimePageLine(currentLine));
  return lines;
}

function runtimePageLine(chars: readonly any[]): ReaderSelectionLine {
  return {
    text: runtimeCharsText(chars),
    rect: [
      Math.min(...chars.map((char) => char.inlineRect[0])),
      Math.min(...chars.map((char) => char.inlineRect[1])),
      Math.max(...chars.map((char) => char.inlineRect[2])),
      Math.max(...chars.map((char) => char.inlineRect[3])),
    ],
  };
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

function isRuntimePageChar(value: unknown): value is {
  c: string;
  ignorable?: boolean;
  spaceAfter?: boolean;
  lineBreakAfter?: boolean;
  paragraphBreakAfter?: boolean;
  inlineRect: [number, number, number, number];
} {
  return isRuntimeChar(value) && isCoordinateRect((value as any).inlineRect);
}

function isRectList(
  value: unknown,
): value is [number, number, number, number][] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((rect) => isCoordinateRect(rect))
  );
}

function isCoordinateRect(
  value: unknown,
): value is [number, number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((coordinate) => Number.isFinite(coordinate))
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
