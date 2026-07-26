import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  findContainingPage,
  getRenderedPageSurfaceRect,
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

test("ignores unrendered pages while locating the selected page", () => {
  const pageRect = (left: number, top: number, width: number, height: number) =>
    ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    }) as DOMRect;
  const unrenderedPage = {
    getBoundingClientRect: () => pageRect(0, 0, 600, 800),
    querySelector() {
      throw new Error("Page lookup must not inspect rendering children");
    },
  } as unknown as HTMLElement;
  const selectedPage = {
    getBoundingClientRect: () => pageRect(0, 900, 600, 800),
    querySelector() {
      throw new Error("Page lookup must not inspect rendering children");
    },
  } as unknown as HTMLElement;

  assert.equal(
    findContainingPage([unrenderedPage, selectedPage], [100, 1000, 500, 1500]),
    selectedPage,
  );
});

test("uses only the selected page Canvas Wrapper as the page surface", () => {
  const expected = {
    left: 20,
    top: 30,
    right: 620,
    bottom: 830,
    width: 600,
    height: 800,
  } as DOMRect;
  const wrapper = {
    getBoundingClientRect: () => expected,
  };
  const renderedPage = {
    querySelector(selector: string) {
      assert.equal(selector, ".canvasWrapper");
      return wrapper;
    },
  } as unknown as HTMLElement;
  const unrenderedPage = {
    querySelector: () => null,
  } as unknown as HTMLElement;

  assert.equal(getRenderedPageSurfaceRect(renderedPage), expected);
  assert.throws(
    () => getRenderedPageSurfaceRect(unrenderedPage),
    /has not finished rendering/,
  );
});

test("uses Reader geometry only and never captures PDF pixels", async () => {
  const source = await readFile(
    new URL("../src/modules/imageRegionSelection.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /getBoundingClientRect/);
  assert.match(source, /querySelector\("\.canvasWrapper"\)/);
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
