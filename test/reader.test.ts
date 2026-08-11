import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeReaderAnnotationSelection,
  normalizeReaderSelection,
} from "../src/modules/reader";
import { normalizeTaskText } from "../src/utils/task";

test("removes IEEE cross-page footer and access notice noise", () => {
  const selected = [
    "The key 979-8-3503-9354-5/24/$31.00 ©2024 IEEE 2D-1 171 2024 29th Asia and South Pacific Design Automation Conference (ASP-DAC) | 979-8-3503-9354-5/24/$31.00 ©2024 IEEE | DOI: 10.1109/ASP-DAC58780.2024.10473881 Authorized licensed use limited to: Southeast University. Downloaded on July 16, 2026 at 07:25:45 UTC from IEEE Xplore. Restrictions apply. is to remove",
    "redundant parasitic RC nodes from cell graph while maintain the dominant RC.",
  ].join("\n");
  assert.equal(
    normalizeReaderSelection(selected),
    "The key is to remove redundant parasitic RC nodes from cell graph while maintain the dominant RC.",
  );
});

test("task normalization retains paragraph and bullet line breaks", () => {
  assert.equal(
    normalizeTaskText("first\r\n\r\n• second\u0001"),
    "first\n\n• second",
  );
});

test("preserves bullet boundaries while joining visual line wraps", () => {
  const selected = [
    "• To the best of our knowledge, this is the first work to apply",
    "heterogeneous graph learning.",
    "• A statistical timing prediction framework is established based",
    "on HGAT.",
    "• The tremendous parasitic RC nodes are reduced efficiently.",
  ].join("\n");
  assert.equal(
    normalizeReaderSelection(selected),
    [
      "• To the best of our knowledge, this is the first work to apply heterogeneous graph learning.",
      "• A statistical timing prediction framework is established based on HGAT.",
      "• The tremendous parasitic RC nodes are reduced efficiently.",
    ].join("\n"),
  );
});

test("keeps an inline bullet operator inside a semantic line", () => {
  assert.equal(
    normalizeReaderSelection(
      "The similarity is defined as a • b\nfor each pair.",
    ),
    "The similarity is defined as a • b for each pair.",
  );
});

test("preserves formulas, standalone numeric content, and semantic hyphens", () => {
  assert.equal(
    normalizeReaderSelection(
      "The sample size was\n128\nwith m²/σ². A well-\nknown method uses x -\ny.",
    ),
    "The sample size was 128 with m²/σ². A well-known method uses x - y.",
  );
  assert.equal(normalizeTaskText("m²/σ²"), "m²/σ²");
});

test("does not remove a semantic restrictions sentence without IEEE furniture", () => {
  assert.equal(
    normalizeReaderSelection(
      "The following restrictions apply. The method remains valid.",
    ),
    "The following restrictions apply. The method remains valid.",
  );
});

test("never spans semantic text while removing separated IEEE furniture", () => {
  const selected = [
    "979-8-3503-9354-5/24/$31.00 ©2024 IEEE",
    "This semantic paragraph reports the measured timing improvement.",
    "Restrictions apply.",
  ].join("\n");
  const normalized = normalizeReaderSelection(selected);
  assert.match(
    normalized,
    /This semantic paragraph reports the measured timing improvement\./,
  );
});

test("skips a figure above the continued prose on the second selected page", () => {
  const firstPageText =
    "wherein each thread is executing the same program while operating on different sets";
  const nextPageText =
    "Fig. 3. GPU memory architecture. of data. For a multi-GPU system, there will be multiple grids.";

  assert.equal(
    normalizeReaderSelection(`${firstPageText} ${nextPageText}`, {
      firstPageText,
      nextPageText,
      nextPageLines: [
        {
          text: "Fig. 3. GPU memory architecture.",
          rect: [48, 684, 286, 696],
        },
        {
          text: "of data. For a multi-GPU system, there will be multiple grids.",
          rect: [48, 612, 518, 624],
        },
      ],
    }),
    `${firstPageText} of data. For a multi-GPU system, there will be multiple grids.`,
  );
});

test("skips an algorithm above the continued prose on the second selected page", () => {
  const firstPageText =
    "there are no dependences among the columns in a given column).";
  const nextPageText =
    "Algorithm 2 Hybrid Column-Based RLA [13] This corresponds to the outer most for loop in Algorithm 1 (index i).";

  assert.equal(
    normalizeReaderSelection(`${firstPageText} ${nextPageText}`, {
      firstPageText,
      nextPageText,
      nextPageLines: [
        {
          text: "Algorithm 2 Hybrid Column-Based RLA [13]",
          rect: [48, 116, 412, 128],
        },
        {
          text: "This corresponds to the outer most for loop in Algorithm 1 (index i).",
          rect: [48, 92, 518, 104],
        },
      ],
    }),
    `${firstPageText} This corresponds to the outer most for loop in Algorithm 1 (index i).`,
  );
});

test("skips a table above the continued prose on the second selected page", () => {
  const firstPageText =
    "The measured results remain consistent across workloads.";
  const nextPageText =
    "TABLE II RUNTIME COMPARISON Method CPU GPU Baseline 21.4 8.3 The proposed scheduler reduces runtime.";

  assert.equal(
    normalizeReaderSelection(`${firstPageText} ${nextPageText}`, {
      firstPageText,
      nextPageText,
      nextPageLines: [
        { text: "TABLE II", rect: [210, 706, 282, 718] },
        { text: "RUNTIME COMPARISON", rect: [165, 684, 328, 696] },
        { text: "Method CPU GPU", rect: [84, 647, 442, 659] },
        { text: "Baseline 21.4 8.3", rect: [84, 625, 442, 637] },
        {
          text: "The proposed scheduler reduces runtime.",
          rect: [48, 556, 518, 568],
        },
      ],
    }),
    `${firstPageText} The proposed scheduler reduces runtime.`,
  );
});

test("uses the current Reader selection layout to clean a cross-page annotation", () => {
  const firstPageText =
    "wherein each thread is executing the same program while operating on different sets";
  const caption = "Fig. 3. GPU memory architecture.";
  const continued =
    "of data. For a multi-GPU system, there will be multiple grids.";
  const firstRect = [48, 84, 518, 96];
  // Zotero excludes the figure body from the text selection, so the selected
  // caption and the continued prose are adjacent even though a figure is above.
  const captionRect = [48, 116, 286, 128];
  const continuedRect = [48, 92, 518, 104];
  const annotation = {
    text: `${firstPageText} ${caption} ${continued}`,
    position: {
      pageIndex: 3,
      rects: [firstRect],
      nextPageRects: [captionRect, continuedRect],
    },
  };
  const reader = {
    _internalReader: {
      _lastView: {
        _selectionRanges: [
          {
            pageIndex: 3,
            anchorOffset: 0,
            headOffset: 1,
            text: firstPageText,
            position: { pageIndex: 3, rects: [firstRect] },
          },
          {
            pageIndex: 4,
            anchorOffset: 0,
            headOffset: 2,
            text: `${caption} ${continued}`,
            position: {
              pageIndex: 4,
              rects: [captionRect, continuedRect],
            },
          },
        ],
        _pdfPages: {
          3: {
            chars: [
              {
                c: firstPageText,
                inlineRect: firstRect,
                lineBreakAfter: true,
              },
            ],
          },
          4: {
            chars: [
              {
                c: caption,
                inlineRect: captionRect,
                lineBreakAfter: true,
              },
              {
                c: continued,
                inlineRect: continuedRect,
                lineBreakAfter: true,
              },
            ],
          },
        },
      },
    },
  };

  assert.equal(
    normalizeReaderAnnotationSelection(reader, annotation),
    `${firstPageText} ${continued}`,
  );
});

test("keeps semantic figure and algorithm references in body text", () => {
  const firstPageText = "The ablation confirms the same trend.";
  const nextPageText =
    "The memory layout is as shown in Fig. 3. Algorithm 2 improves the factorization throughput.";

  assert.equal(
    normalizeReaderSelection(`${firstPageText} ${nextPageText}`, {
      firstPageText,
      nextPageText,
      nextPageLines: [
        {
          text: "The memory layout is as shown in Fig. 3.",
          rect: [48, 686, 518, 698],
        },
        {
          text: "Algorithm 2 improves the factorization throughput.",
          rect: [48, 612, 518, 624],
        },
      ],
    }),
    `${firstPageText} ${nextPageText}`,
  );
});

test("keeps second-page prose that appears before a floating object", () => {
  const firstPageText = "The page break occurs after this sentence.";
  const nextPageText =
    "This paragraph starts the second page. Fig. 3. GPU memory architecture. The discussion resumes below the figure.";

  assert.equal(
    normalizeReaderSelection(`${firstPageText} ${nextPageText}`, {
      firstPageText,
      nextPageText,
      nextPageLines: [
        {
          text: "This paragraph starts the second page.",
          rect: [48, 716, 518, 728],
        },
        {
          text: "Fig. 3. GPU memory architecture.",
          rect: [48, 684, 286, 696],
        },
        {
          text: "The discussion resumes below the figure.",
          rect: [48, 612, 518, 624],
        },
      ],
    }),
    `${firstPageText} ${nextPageText}`,
  );
});

test("stops discarding at the first prose boundary below a floating object", () => {
  const firstPageText = "The sentence continues across the page break";
  const nextPageText =
    "Fig. 3. GPU memory architecture. of data. The GPU program remains a kernel. A later section starts here.";

  assert.equal(
    normalizeReaderSelection(`${firstPageText} ${nextPageText}`, {
      firstPageText,
      nextPageText,
      nextPageLines: [
        {
          text: "Fig. 3. GPU memory architecture.",
          rect: [48, 700, 286, 712],
        },
        { text: "of data.", rect: [48, 640, 518, 652] },
        {
          text: "The GPU program remains a kernel.",
          rect: [48, 620, 518, 632],
        },
        {
          text: "A later section starts here.",
          rect: [48, 500, 518, 512],
        },
      ],
    }),
    `${firstPageText} of data. The GPU program remains a kernel. A later section starts here.`,
  );
});

test("leaves an unverified Reader selection unchanged", () => {
  const annotation = {
    text: "first page Fig. 3. GPU memory architecture. continued prose",
    position: {
      pageIndex: 0,
      rects: [[48, 84, 518, 96]],
      nextPageRects: [
        [48, 684, 286, 696],
        [48, 612, 518, 624],
      ],
    },
  };
  const reader = {
    _internalReader: {
      _lastView: {
        _selectionRanges: [
          {
            pageIndex: 0,
            anchorOffset: 0,
            headOffset: 1,
            text: "different first page",
            position: { pageIndex: 0, rects: annotation.position.rects },
          },
          {
            pageIndex: 1,
            anchorOffset: 0,
            headOffset: 2,
            text: "Fig. 3. GPU memory architecture. continued prose",
            position: {
              pageIndex: 1,
              rects: annotation.position.nextPageRects,
            },
          },
        ],
      },
    },
  };

  assert.equal(
    normalizeReaderAnnotationSelection(reader, annotation),
    annotation.text,
  );
});
