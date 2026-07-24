import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  normalizeDisplaySelection,
  parseReaderPageIndex,
} from "../src/modules/imageRegionSelection";

test("parses Reader page indexes without guessing", () => {
  const withNumber = {
    getAttribute(name: string) {
      return name === "data-page-number" ? "7" : null;
    },
  } as unknown as Element;
  const withIndex = {
    getAttribute(name: string) {
      return name === "data-page-index" ? "3" : null;
    },
  } as unknown as Element;
  assert.equal(parseReaderPageIndex(withNumber), 6);
  assert.equal(parseReaderPageIndex(withIndex), 3);
  assert.throws(
    () =>
      parseReaderPageIndex({
        getAttribute: () => null,
      } as unknown as Element),
    /no valid page index/,
  );
});

test("normalizes a viewport crop into MinerU page coordinates", () => {
  assert.deepEqual(
    normalizeDisplaySelection(
      { left: 100, top: 50, width: 800, height: 1000 },
      [300, 300, 700, 800],
    ),
    [250, 250, 750, 750],
  );
  assert.throws(
    () =>
      normalizeDisplaySelection(
        { left: 100, top: 50, width: 800, height: 1000 },
        [90, 300, 700, 800],
      ),
    /inside one rendered page/,
  );
});

test("uses Reader geometry only and never captures PDF pixels", async () => {
  const source = await readFile(
    new URL("../src/modules/imageRegionSelection.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /getBoundingClientRect/);
  assert.doesNotMatch(
    source,
    /drawWindow|captureRegion|PDFViewerApplication.*render|getContext\(/,
  );
});

test("revalidates the paper before OCR and never switches OCR providers", async () => {
  const source = await readFile(
    new URL("../src/ocr/controller.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /readCachedOcrText[\s\S]+assertPaperContextCurrent[\s\S]+runOcrWithTimeout/,
  );
  assert.match(source, /persistCachedOcrText/);
  assert.doesNotMatch(
    source,
    /app-server|Tesseract|PaddleOCR|captureRegion|drawWindow|read.*PDF/iu,
  );
});
