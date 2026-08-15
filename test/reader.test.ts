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

test("removes selected figure text before a cross-page figure caption", () => {
  const firstPageText = "As matrices in circuit simulations are";
  const nextPageLines = [
    {
      text: "Thread 1 Thread 2 level nodes cluster mode pipeline mode",
      rect: [120, 650, 880, 662],
      paragraphBreakAfter: true,
    },
    {
      text: "(a) Levelization (b) Task assignment (c) Timing diagram (d) Pipeline illustration",
      rect: [120, 630, 880, 642],
      paragraphBreakAfter: true,
    },
    {
      text: "Fig. 3: Levelization-based dual-mode parallel scheduling method [6], [7]. This example does not correspond to Fig. 2.",
      rect: [57, 580, 852, 592],
      paragraphBreakAfter: true,
    },
    {
      text: "generally much sparser than matrices from other applica-",
      rect: [20, 500, 690, 512],
      paragraphBreakAfter: false,
    },
    {
      text: "tions",
      rect: [20, 480, 690, 492],
      paragraphBreakAfter: false,
    },
  ] as const;
  const nextPageText = nextPageLines
    .map(
      ({ text, paragraphBreakAfter }) =>
        `${text}${paragraphBreakAfter ? "  " : " "}`,
    )
    .join("")
    .trim();
  const nextPageRects = nextPageLines.map(({ rect }) => rect);
  const firstRect = [501, 837, 924, 959];
  const annotation = {
    text: `${firstPageText} ${nextPageText}`,
    position: {
      pageIndex: 2,
      rects: [firstRect],
      nextPageRects,
    },
  };
  const reader = {
    _internalReader: {
      _lastView: {
        _selectionRanges: [
          {
            pageIndex: 2,
            anchorOffset: 0,
            headOffset: 1,
            text: firstPageText,
            position: { pageIndex: 2, rects: [firstRect] },
          },
          {
            pageIndex: 3,
            anchorOffset: 0,
            headOffset: nextPageLines.length,
            text: nextPageText,
            position: { pageIndex: 3, rects: nextPageRects },
          },
        ],
        _pdfPages: {
          2: {
            chars: [{ c: firstPageText, lineBreakAfter: true }],
          },
          3: {
            chars: nextPageLines.map(({ text, paragraphBreakAfter }) => ({
              c: text,
              lineBreakAfter: true,
              paragraphBreakAfter,
            })),
          },
        },
      },
    },
  };

  assert.equal(
    normalizeReaderAnnotationSelection(reader, annotation),
    `${firstPageText} generally much sparser than matrices from other applica- tions`,
  );
});

test("removes selected figure text after a cross-page figure caption", () => {
  const firstPageText = "The sentence continues across the page break";
  const nextPageLines = [
    {
      text: "Fig. 3. GPU memory architecture.",
      rect: [48, 700, 286, 712],
    },
    {
      text: "Thread 1 Thread 2 level nodes cluster mode pipeline mode",
      rect: [120, 680, 480, 692],
    },
    {
      text: "on the second selected page.",
      rect: [48, 612, 518, 624],
    },
  ] as const;
  const nextPageText = nextPageLines.map(({ text }) => text).join(" ");

  assert.equal(
    normalizeReaderSelection(`${firstPageText} ${nextPageText}`, {
      firstPageText,
      nextPageText,
      nextPageLines,
    }),
    `${firstPageText} on the second selected page.`,
  );
});

test("removes page furniture before cross-page algorithm and table headings", () => {
  const firstPageText = "The measured results remain consistent.";
  const algorithmLines = [
    { text: "4", rect: [510, 716, 518, 728] },
    {
      text: "Algorithm 2 Hybrid Column-Based RLA [13]",
      rect: [48, 116, 412, 128],
    },
    {
      text: "This corresponds to the outer most loop in Algorithm 1.",
      rect: [48, 92, 518, 104],
    },
  ] as const;
  const algorithmText = algorithmLines.map(({ text }) => text).join(" ");
  assert.equal(
    normalizeReaderSelection(`${firstPageText} ${algorithmText}`, {
      firstPageText,
      nextPageText: algorithmText,
      nextPageLines: algorithmLines,
    }),
    `${firstPageText} This corresponds to the outer most loop in Algorithm 1.`,
  );

  const tableLines = [
    { text: "4", rect: [510, 716, 518, 728] },
    { text: "TABLE II", rect: [210, 706, 282, 718] },
    { text: "RUNTIME COMPARISON", rect: [165, 684, 328, 696] },
    { text: "Method CPU GPU", rect: [84, 647, 442, 659] },
    { text: "Baseline 21.4 8.3", rect: [84, 625, 442, 637] },
    {
      text: "The proposed scheduler reduces runtime.",
      rect: [48, 556, 518, 568],
    },
  ] as const;
  const tableText = tableLines.map(({ text }) => text).join(" ");
  assert.equal(
    normalizeReaderSelection(`${firstPageText} ${tableText}`, {
      firstPageText,
      nextPageText: tableText,
      nextPageLines: tableLines,
    }),
    `${firstPageText} The proposed scheduler reduces runtime.`,
  );
});

test("keeps wrapped prose before a later cross-page figure", () => {
  const firstPageText = "The page break occurs after this sentence.";
  const nextPageLines = [
    {
      text: "This paragraph starts on",
      rect: [48, 716, 518, 728],
    },
    { text: "the second selected page.", rect: [48, 696, 518, 708] },
    {
      text: "Fig. 3. GPU memory architecture.",
      rect: [48, 650, 286, 662],
    },
    {
      text: "The discussion resumes below the figure.",
      rect: [48, 580, 518, 592],
    },
  ] as const;
  const nextPageText = nextPageLines.map(({ text }) => text).join(" ");

  assert.equal(
    normalizeReaderSelection(`${firstPageText} ${nextPageText}`, {
      firstPageText,
      nextPageText,
      nextPageLines,
    }),
    `${firstPageText} ${nextPageText}`,
  );
});

test("removes consecutive figures before cross-page prose", () => {
  const firstPageText = "The sentence continues across the page break";
  const nextPageLines = [
    {
      text: "Fig. 3. GPU memory architecture.",
      rect: [48, 700, 286, 712],
    },
    { text: "Thread 1 Thread 2", rect: [120, 680, 480, 692] },
    {
      text: "Fig. 4. CPU memory architecture.",
      rect: [48, 600, 286, 612],
    },
    {
      text: "on the second selected page.",
      rect: [48, 520, 518, 532],
    },
  ] as const;
  const nextPageText = nextPageLines.map(({ text }) => text).join(" ");

  assert.equal(
    normalizeReaderSelection(`${firstPageText} ${nextPageText}`, {
      firstPageText,
      nextPageText,
      nextPageLines,
    }),
    `${firstPageText} on the second selected page.`,
  );
});

test("keeps semantic headings and bullets before a later figure", () => {
  const firstPageText = "The previous page ends here.";
  for (const semanticLine of [
    "III. CKTSO OVERVIEW",
    "• The first contribution remains selected.",
  ]) {
    const nextPageLines = [
      { text: semanticLine, rect: [48, 716, 518, 728] },
      {
        text: "Fig. 3. GPU memory architecture.",
        rect: [48, 650, 286, 662],
      },
      {
        text: "The discussion resumes below the figure.",
        rect: [48, 580, 518, 592],
      },
    ] as const;
    const nextPageText = nextPageLines.map(({ text }) => text).join(" ");

    assert.equal(
      normalizeReaderSelection(`${firstPageText} ${nextPageText}`, {
        firstPageText,
        nextPageText,
        nextPageLines,
      }),
      `${firstPageText} ${nextPageText}`,
    );
  }
});

test("keeps ambiguous object text without a verified caption boundary", () => {
  const firstPageText = "The sentence continues across the page break";
  const cases = [
    [
      { text: "Thread 1 Thread 2", rect: [120, 700, 480, 712] },
      {
        text: "on the second selected page.",
        rect: [48, 620, 518, 632],
      },
    ],
    [
      {
        text: "Fig. 3. GPU memory architecture.",
        rect: [48, 700, 286, 712],
      },
      { text: "Thread 1 Thread 2", rect: [120, 680, 480, 692] },
      {
        text: "on the second selected page.",
        rect: [48, 660, 518, 672],
      },
    ],
  ] as const;

  for (const nextPageLines of cases) {
    const nextPageText = nextPageLines.map(({ text }) => text).join(" ");
    assert.equal(
      normalizeReaderSelection(`${firstPageText} ${nextPageText}`, {
        firstPageText,
        nextPageText,
        nextPageLines,
      }),
      `${firstPageText} ${nextPageText}`,
    );
  }
});

test("removes a rotated arXiv margin label from a cross-page annotation", () => {
  const firstPageText =
    "For triangular solving, the parallelism and computation-to-communication ratio are both extremely low, and it is extremely difficult to get speedups";
  const marginLabel = "arXiv:2411.14082v2 [cs.AR] 27 Nov 2024";
  const nextPageText = "by parallelism.";
  const firstTextRect = [822, 44, 1490, 88];
  const marginRect = [40, 16, 64, 389];
  const nextTextRect = [120, 1198, 346, 1222];
  const annotation = {
    text: `${firstPageText} ${marginLabel} ${nextPageText}`,
    position: {
      pageIndex: 1,
      rects: [firstTextRect, marginRect],
      nextPageRects: [nextTextRect],
    },
  };
  const reader = {
    _internalReader: {
      _lastView: {
        _selectionRanges: [
          {
            pageIndex: 1,
            anchorOffset: 0,
            headOffset: 2,
            text: `${firstPageText} ${marginLabel}`,
            position: {
              pageIndex: 1,
              rects: [firstTextRect, marginRect],
            },
          },
          {
            pageIndex: 2,
            anchorOffset: 0,
            headOffset: 1,
            text: nextPageText,
            position: { pageIndex: 2, rects: [nextTextRect] },
          },
        ],
        _pdfPages: {
          1: {
            chars: [
              {
                c: firstPageText,
                inlineRect: firstTextRect,
                lineBreakAfter: true,
              },
              {
                c: marginLabel,
                inlineRect: marginRect,
                lineBreakAfter: true,
              },
            ],
          },
          2: {
            chars: [
              {
                c: nextPageText,
                inlineRect: nextTextRect,
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
    `${firstPageText} ${nextPageText}`,
  );
});

test("keeps a horizontal arXiv reference in cross-page body text", () => {
  const firstPageText =
    "The implementation is archived as arXiv:2411.14082v2 [cs.AR] 27 Nov 2024";
  const nextPageText = "for reproducibility.";

  assert.equal(
    normalizeReaderSelection(`${firstPageText} ${nextPageText}`, {
      firstPageText,
      firstPageLines: [
        {
          text: "The implementation is archived as",
          rect: [120, 72, 518, 96],
        },
        {
          text: "arXiv:2411.14082v2 [cs.AR] 27 Nov 2024",
          rect: [120, 44, 508, 68],
        },
      ],
      nextPageText,
      nextPageLines: [{ text: nextPageText, rect: [120, 1198, 346, 1222] }],
    }),
    `${firstPageText} ${nextPageText}`,
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
