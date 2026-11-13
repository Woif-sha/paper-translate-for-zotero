import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeReaderAnnotationSelection,
  normalizeReaderSelection,
} from "../src/modules/reader";
import { normalizeTaskText } from "../src/utils/task";

function normalizeSinglePageReaderSelection(
  selectedLines: readonly {
    text: string;
    rect: readonly [number, number, number, number];
  }[],
  unspacedLineBreaks: ReadonlySet<number> = new Set(),
  unselectedDocumentLines: readonly {
    text: string;
    rect: readonly [number, number, number, number];
  }[] = [],
): string {
  const selectedText = selectedLines
    .map(({ text }, index) =>
      index < selectedLines.length - 1
        ? `${text}${unspacedLineBreaks.has(index) ? "" : " "}`
        : text,
    )
    .join("");
  const rects = selectedLines.map(({ rect }) => rect);
  const unselectedChars = unselectedDocumentLines.map(({ text, rect }) => ({
    c: text,
    inlineRect: rect,
    lineBreakAfter: true,
  }));
  const selectedChars = selectedLines.flatMap(({ text, rect }, index) => [
    {
      c: text,
      inlineRect: rect,
      spaceAfter:
        index < selectedLines.length - 1 && !unspacedLineBreaks.has(index),
    },
    { c: "", inlineRect: rect, ignorable: true, lineBreakAfter: true },
  ]);
  const chars = [...unselectedChars, ...selectedChars];
  const annotation = {
    text: selectedText,
    position: { pageIndex: 6, rects },
  };
  const reader = {
    _internalReader: {
      _lastView: {
        _selectionRanges: [
          {
            pageIndex: 6,
            anchorOffset: unselectedChars.length,
            headOffset: chars.length,
            text: selectedText,
            position: { pageIndex: 6, rects },
          },
        ],
        _pdfPages: {
          6: {
            chars,
          },
        },
      },
    },
  };
  return normalizeReaderAnnotationSelection(reader, annotation);
}

function normalizeGlyphReaderSelection(
  pages: readonly (readonly {
    text: string;
    paragraphBreakAfter?: boolean;
    rect?: readonly [number, number, number, number];
  }[])[],
): string {
  const ranges: any[] = [];
  const pdfPages: Record<number, { chars: any[] }> = {};
  for (const [pageIndex, lines] of pages.entries()) {
    const rects = lines.map(
      ({ text, rect }, index) =>
        rect ?? [
          50,
          700 - index * 24,
          50 + Array.from(text).length * 6,
          712 - index * 24,
        ],
    );
    const chars = lines.flatMap((line, lineIndex) =>
      Array.from(line.text, (c, index) => ({
        c,
        inlineRect: [
          rects[lineIndex][0] + index * 6,
          rects[lineIndex][1],
          rects[lineIndex][0] + (index + 1) * 6,
          rects[lineIndex][3],
        ],
        lineBreakAfter: index === line.text.length - 1,
        paragraphBreakAfter:
          index === line.text.length - 1 && line.paragraphBreakAfter,
      })),
    );
    const text = lines
      .map((line) => `${line.text} ${line.paragraphBreakAfter ? " " : ""}`)
      .join("")
      .trim();
    pdfPages[pageIndex] = { chars };
    ranges.push({
      pageIndex,
      anchorOffset: 0,
      headOffset: chars.length,
      text,
      position: { pageIndex, rects },
    });
  }
  const annotation = {
    text: ranges.map(({ text }) => text).join(" "),
    position: {
      pageIndex: 0,
      rects: ranges[0].position.rects,
      ...(ranges[1] ? { nextPageRects: ranges[1].position.rects } : {}),
    },
  };
  return normalizeReaderAnnotationSelection(
    {
      _internalReader: {
        _lastView: { _selectionRanges: ranges, _pdfPages: pdfPages },
      },
    },
    annotation,
  );
}

test("restores flattened Reader list boundaries and joins their visual wraps", () => {
  assert.equal(
    normalizeGlyphReaderSelection([
      [
        { text: "• First item wraps" },
        { text: "onto another visual line." },
        { text: "• Second item." },
        { text: "1. First numbered step." },
        { text: "2. Second numbered step." },
      ],
    ]),
    "• First item wraps onto another visual line.\n• Second item.\n1. First numbered step.\n2. Second numbered step.",
  );
});

test("restores Reader paragraph metadata without splitting ordinary visual lines", () => {
  assert.equal(
    normalizeGlyphReaderSelection([
      [
        { text: "The operator a • b wraps" },
        { text: "inside the first paragraph.", paragraphBreakAfter: true },
        { text: "The second paragraph also" },
        { text: "wraps visually." },
      ],
    ]),
    "The operator a • b wraps inside the first paragraph.\nThe second paragraph also wraps visually.",
  );
});

test("restores a list boundary across verified Reader pages", () => {
  assert.equal(
    normalizeGlyphReaderSelection([
      [{ text: "• First item." }],
      [{ text: "• Second item." }],
    ]),
    "• First item.\n• Second item.",
  );
});

test("restores retained paragraph boundaries after removing verified cross-page furniture", () => {
  assert.equal(
    normalizeGlyphReaderSelection([
      [
        { text: "The first paragraph ends here.", paragraphBreakAfter: true },
        { text: "Repeated journal footer", rect: [50, 37, 188, 49] },
      ],
      [
        { text: "The second paragraph starts here." },
        { text: "Repeated journal footer", rect: [50, 37, 188, 49] },
      ],
    ]),
    "The first paragraph ends here.\nThe second paragraph starts here. Repeated journal footer",
  );
});

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

test("skips consecutive title-case tables before partial cross-page prose", () => {
  const firstPageText = "each standard cell,";
  const nextPageLines = [
    {
      text: "Table II",
      rect: [162.0103, 736.59298, 187.61791, 744.10072],
    },
    {
      text: "PREDICTION ACCURACY COMPARISON BY STD. DEV. OF STANDARD CELL",
      rect: [51.837005, 727.62673, 297.7996912, 735.13472],
    },
    {
      text: "Ave. 10.48 18.36 6.24 7.23 4.68 5.14 3.98 4.36 2.34 2.67",
      rect: [57.0521, 585.152736, 296.974122, 595.707244],
    },
    {
      text: "Table III",
      rect: [160.6833, 557.78068, 188.94492, 565.28842],
    },
    {
      text: "PREDICTION ACCURACY COMPARISON BY STATISTICAL CRITICAL PATH",
      rect: [54.798662, 548.81443, 294.829176, 556.32217],
    },
    {
      text: "Ave. - 19.52 14.44 7.71 4.51 1.34",
      rect: [57.7461, 454.026536, 277.632, 464.581044],
    },
    {
      text: "the statistical timing characterization",
      rect: [49.6061, 418.714324, 190.031592, 427.160296],
    },
  ] as const;
  const nextPageText = nextPageLines.map(({ text }) => text).join(" ");

  assert.equal(
    normalizeReaderSelection(`${firstPageText} ${nextPageText}`, {
      firstPageText,
      firstPageLines: [
        {
          text: firstPageText,
          rect: [490.3867578, 40.4170686, 562.3837378, 48.8630406],
        },
      ],
      nextPageText,
      nextPageLines,
    }),
    `${firstPageText} the statistical timing characterization`,
  );
});

test("keeps a title-case table reference in cross-page prose", () => {
  const firstPageText = "The measurements remain stable.";
  const nextPageText =
    "Table II compares all prediction methods. The discussion continues below.";

  assert.equal(
    normalizeReaderSelection(`${firstPageText} ${nextPageText}`, {
      firstPageText,
      nextPageText,
      nextPageLines: [
        {
          text: "Table II compares all prediction methods.",
          rect: [48, 706, 518, 718],
        },
        {
          text: "The discussion continues below.",
          rect: [48, 688, 518, 700],
        },
      ],
    }),
    `${firstPageText} ${nextPageText}`,
  );
});

test("keeps a trailing lowercase table label with non-body line height", () => {
  const firstPageText = "The comparison includes";
  const nextPageLines = [
    { text: "Table II", rect: [210, 706, 282, 713] },
    { text: "RUNTIME COMPARISON", rect: [165, 684, 328, 691] },
    { text: "training data hours", rect: [84, 640, 188, 647] },
  ] as const;
  const nextPageText = nextPageLines.map(({ text }) => text).join(" ");

  assert.equal(
    normalizeReaderSelection(`${firstPageText} ${nextPageText}`, {
      firstPageText,
      firstPageLines: [{ text: firstPageText, rect: [48, 84, 220, 96] }],
      nextPageText,
      nextPageLines,
    }),
    `${firstPageText} ${nextPageText}`,
  );
});

test("skips a cross-page table regardless of selected body fragment text", () => {
  for (const bodyFragment of [
    "Results",
    "45 corners",
    "RRMSE = 2.1%",
  ] as const) {
    const firstPageText = "The comparison continues";
    const nextPageLines = [
      { text: "Table II", rect: [210, 706, 282, 713] },
      { text: "RUNTIME COMPARISON", rect: [165, 684, 328, 691] },
      { text: "AN2 9.93 14.51", rect: [84, 640, 188, 647] },
      { text: bodyFragment, rect: [48, 580, 220, 592] },
    ] as const;
    const nextPageText = nextPageLines.map(({ text }) => text).join(" ");

    assert.equal(
      normalizeReaderSelection(`${firstPageText} ${nextPageText}`, {
        firstPageText,
        firstPageLines: [{ text: firstPageText, rect: [48, 84, 220, 96] }],
        nextPageText,
        nextPageLines,
      }),
      `${firstPageText} ${bodyFragment}`,
    );
  }
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

test("removes a wrapped trailing figure caption before partial prose", () => {
  const firstPageText = "CKTSO uses a";
  const nextPageLines = [
    {
      text: "Sub-graph: X X Y S (a) (b) Sub-graph: Y Separator: S",
      rect: [190, 620, 745, 632],
    },
    {
      text: "Fig. 5: Nested dissection ordering. (a) Graph partitioning. (b)",
      rect: [65, 580, 870, 592],
    },
    {
      text: "Corresponding bordered block diagonal matrix.",
      rect: [65, 560, 685, 572],
    },
    {
      text: "combination of them",
      rect: [65, 480, 305, 492],
    },
  ] as const;
  const nextPageText = nextPageLines.map(({ text }) => text).join(" ");

  assert.equal(
    normalizeReaderSelection(`${firstPageText} ${nextPageText}`, {
      firstPageText,
      nextPageText,
      nextPageLines,
    }),
    `${firstPageText} combination of them`,
  );
});

test("removes question-shaped flowchart labels before trailing prose", () => {
  const firstPageText = "although nodes 8 and 10";
  const nextPageLines = [
    { text: "Create EGraph", rect: [530, 610, 705, 622] },
    {
      text: "Structure of LU factors changed?",
      rect: [180, 590, 500, 602],
    },
    {
      text: "Cluster mode fast factorization with pivot check",
      rect: [178, 520, 485, 545],
    },
    {
      text: "Pipeline mode fast factorization with pivot check",
      rect: [178, 440, 485, 465],
    },
    { text: "Restart node determination", rect: [540, 440, 840, 452] },
    {
      text: "Pipelined tail factorization with pivoting",
      rect: [540, 390, 840, 415],
    },
    { text: "Re-pivoting needed?", rect: [180, 480, 480, 492] },
    { text: "Re-pivoting needed?", rect: [180, 360, 480, 372] },
    { text: "Yes Yes Yes No No No", rect: [300, 340, 700, 352] },
    {
      text: "Circuit simulation iterations",
      rect: [120, 330, 145, 570],
    },
    {
      text: "Fig. 6: Flow of parallel fast LU factorization algorithm.",
      rect: [118, 280, 850, 292],
    },
    { text: "are finished.", rect: [82, 190, 245, 202] },
  ] as const;
  const nextPageText = nextPageLines.map(({ text }) => text).join(" ");

  assert.equal(
    normalizeReaderSelection(`${firstPageText} ${nextPageText}`, {
      firstPageText,
      nextPageText,
      nextPageLines,
    }),
    `${firstPageText} are finished.`,
  );
});

test("removes pseudocode before a wrapped colon-style algorithm caption", () => {
  const firstPageText = "which explores";
  const nextPageLines = [
    {
      text: "1 interrupted = 0; /* shared variable for all threads */",
      rect: [125, 620, 596, 632],
    },
    { text: "2 for threads in parallel do", rect: [125, 600, 440, 612] },
    {
      text: "3 for row i assigned to this thread do",
      rect: [155, 580, 500, 592],
    },
    { text: "4 x = A(i,:);", rect: [205, 560, 350, 572] },
    {
      text: "5 for j = 1 : i - 1 where L(i,j) is nonzero do",
      rect: [205, 540, 575, 552],
    },
    { text: "6 while !finish[j] do", rect: [235, 520, 430, 532] },
    { text: "7 if interrupted then", rect: [265, 500, 425, 512] },
    { text: "8 exit thread;", rect: [295, 480, 405, 492] },
    {
      text: "9 x(j + 1 : N) = x(j) × U(j, j + 1 : N);",
      rect: [235, 450, 585, 462],
    },
    {
      text: "10 if |x(i)| < ε × max i+1≤k≤N {|x(k)|} then",
      rect: [205, 420, 590, 432],
    },
    { text: "11 interrupted = 1;", rect: [235, 400, 410, 412] },
    { text: "12 exit thread;", rect: [235, 380, 380, 392] },
    { text: "13 L(i, 1 : i) = x(1 : i);", rect: [205, 360, 440, 372] },
    {
      text: "14 U(i, i : N) = x(i : N)/x(i);",
      rect: [205, 340, 485, 352],
    },
    { text: "15 finish[i] = 1;", rect: [205, 320, 385, 332] },
    {
      text: "Algorithm 4: Pipeline mode of fast factorization with",
      rect: [135, 280, 585, 292],
    },
    { text: "pivot check.", rect: [135, 260, 300, 272] },
    { text: "parallelism", rect: [125, 190, 250, 202] },
  ] as const;
  const nextPageText = nextPageLines.map(({ text }) => text).join(" ");

  assert.equal(
    normalizeReaderSelection(`${firstPageText} ${nextPageText}`, {
      firstPageText,
      nextPageText,
      nextPageLines,
    }),
    `${firstPageText} parallelism`,
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

test("removes an embedded figure block when a selection crosses columns", () => {
  const selectedLines = [
    { text: "Assume", rect: [0, 42, 205, 54] },
    {
      text: "1 2 3 4 5 6 7 8 9 10 1 2 3 4 5 6 7 8 9 10",
      rect: [407, 700, 735, 712],
    },
    { text: "Nonzeros Fill-ins", rect: [407, 520, 578, 532] },
    {
      text: "Fig. 7: Example of re-pivoting on row 6: columns 6 and 10",
      rect: [234, 480, 737, 492],
    },
    {
      text: "are exchanged, incurring an additional dependency of row 10.",
      rect: [234, 460, 737, 472],
    },
    { text: "that columns 6", rect: [234, 380, 420, 392] },
  ] as const;
  assert.equal(
    normalizeSinglePageReaderSelection(selectedLines),
    "Assume that columns 6",
  );
});

test("removes consecutive embedded figures when a selection crosses columns", () => {
  const selectedLines = [
    {
      text: "one",
      rect: [285.6355256, 33.5840784, 300.02152, 42.2216526],
    },
    {
      text: "Fig. 8: Typical distribution of nonzero elements of LU factors.",
      rect: [311.978, 570.9530784, 563.03552, 579.5906526],
    },
    {
      text: "Rectangular block",
      rect: [317.8932119, 493.9971153, 355.4965555, 499.2903283],
    },
    {
      text: "Sparse triangular block",
      rect: [314.9804249, 514.4086109, 348.3445976, 525.445664],
    },
    {
      text: "Dense triangular block",
      rect: [365.3423873, 495.6795915, 399.7566737, 506.7166445],
    },
    {
      text: "Partitioning position (P0)",
      rect: [367.9067296, 510.172835, 392.7403666, 521.548246],
    },
    {
      text: "(a) (b) (c) R1R2 T1 T2 P0 P1 Rm Tm Pm-1 Pm=N",
      rect: [341.6073959, 477.6859511, 562.5071492, 511.2910183],
    },
    {
      text: "Triangular piece Rectangular slice",
      rect: [413.6730779, 501.979896, 476.5443851, 519.8985545],
    },
    {
      text: "Fig. 9: Partitioning lower triangular matrix. (a) Coarse-grained",
      rect: [311.978, 460.8120784, 563.03552, 469.4496526],
    },
    {
      text: "partitioning. (b) Fine-grained partitioning. (c) Final partition",
      rect: [311.978, 448.8570784, 563.03552, 457.4946526],
    },
    {
      text: "ing.",
      rect: [311.978, 436.9020784, 327.2008528, 445.5396526],
    },
    {
      text: "should group the elements with some similar features such that",
      rect: [311.978, 402.1970784, 563.03552, 410.8346526],
    },
    {
      text: "they can be scheduled together.",
      rect: [311.978, 390.2420784, 440.595166, 398.8796526],
    },
  ] as const;

  assert.equal(
    normalizeSinglePageReaderSelection(selectedLines, new Set([9])),
    "one should group the elements with some similar features such that they can be scheduled together.",
  );
});

test("removes a bottom footnote before embedded figures when a selection crosses columns", () => {
  const selectedLines = [
    {
      text: "any information the",
      rect: [222.3102519, 119.22043989, 301.2862363, 128.38694769],
    },
    { text: "1", rect: [63.8509, 100.8517904, 66.7702, 106.3517516] },
    {
      text: "Actual mobility modeling in BSIM4 is more complex and depends on the",
      rect: [67.2568, 97.6444108, 301.2882361, 104.9775982],
    },
    {
      text: "selected mobility model with parameter ”MobMod” [15]",
      rect: [56.06629375, 89.5872463, 237.61328245, 96.9204337],
    },
    {
      text: "Fig. 1. Example circuit to explain SPICE basics.",
      rect: [356.2947, 655.7556108, 514.85191266, 663.0887982],
    },
    {
      text: "Circuit Matrix as Sum of Submatrices",
      rect: [369.28208384, 630.30643632, 502.80015584, 637.56302272],
    },
    {
      text: "Fig. 2. Definition of topology matrix with single column circuit element",
      rect: [312.9646, 458.2602108, 558.18109306, 465.5933982],
    },
    {
      text: "stamps and single column circuit matrix.",
      rect: [312.9646, 450.2030463, 443.58252436, 457.5362337],
    },
    {
      text: "reliability model might need (e.g., transistor toggling rate,",
      rect: [312.9646, 418.9708076, 558.19593017, 428.1373154],
    },
    {
      text: "integral of voltages).",
      rect: [312.9646, 408.227894, 395.37656519, 417.3944018],
    },
  ] as const;

  assert.equal(
    normalizeSinglePageReaderSelection(selectedLines, new Set(), [
      { text: "Page heading", rect: [56, 700, 558, 712] },
      { text: "1", rect: [300, 20, 306, 28] },
    ]),
    "any information the reliability model might need (e.g., transistor toggling rate, integral of voltages).",
  );
});

test("removes a bottom footnote from a direct cross-column selection", () => {
  const selectedLines = [
    { text: "any information the", rect: [222, 119, 301, 128] },
    { text: "1", rect: [64, 101, 67, 106.5] },
    {
      text: "A selected model has additional implementation details",
      rect: [67.5, 97.5, 301, 105],
    },
    { text: "described in its documentation.", rect: [56, 89.5, 238, 97] },
    {
      text: "reliability model might need additional data.",
      rect: [313, 419, 558, 428],
    },
  ] as const;

  assert.equal(
    normalizeSinglePageReaderSelection(selectedLines, new Set(), [
      { text: "Page heading", rect: [56, 700, 558, 712] },
      { text: "1", rect: [300, 20, 306, 28] },
    ]),
    "any information the reliability model might need additional data.",
  );
});

test("removes an unnumbered author footnote from a direct cross-column selection", () => {
  const selectedLines = [
    {
      text: "triangular matrix. Finally,",
      rect: [220, 119, 301, 128],
    },
    {
      text: "This work was supported by National Natural Science Foundation of China",
      rect: [221, 82, 301, 89],
    },
    {
      text: "under Grant 62122076 and Grant 62488101. X. Chen is with Institute of",
      rect: [221, 73, 301, 80],
    },
    {
      text: "Computing Technology, Chinese Academy of Sciences, Beijing 100190, China.",
      rect: [221, 64, 301, 71],
    },
    {
      text: "the solution x is obtained by solving two triangular systems, Ly = b and Ux = y.",
      rect: [313, 419, 558, 428],
    },
  ] as const;

  assert.equal(
    normalizeSinglePageReaderSelection(selectedLines, new Set(), [
      { text: "Page heading", rect: [56, 700, 558, 712] },
      { text: "1", rect: [300, 20, 306, 28] },
    ]),
    "triangular matrix. Finally, the solution x is obtained by solving two triangular systems, Ly = b and Ux = y.",
  );
});

test("removes a page-bottom footnote separated by less than one body line", () => {
  const selectedLines = [
    { text: "triangular matrix. Finally,", rect: [220, 119, 301, 128] },
    {
      text: "This work was supported by a research foundation under two grants.",
      rect: [221, 104, 301, 111],
    },
    {
      text: "The authors are with a research institute and can be contacted by email.",
      rect: [221, 95, 301, 102],
    },
    {
      text: "Their institutional address appears at the bottom of the page.",
      rect: [221, 86, 301, 93],
    },
    {
      text: "the solution x is obtained by solving two triangular systems.",
      rect: [313, 419, 558, 428],
    },
  ] as const;

  assert.equal(
    normalizeSinglePageReaderSelection(selectedLines, new Set(), [
      { text: "Page heading", rect: [56, 700, 558, 712] },
      { text: "1", rect: [300, 20, 306, 28] },
    ]),
    "triangular matrix. Finally, the solution x is obtained by solving two triangular systems.",
  );
});

test("keeps the same page-bottom block without relative visual separation", () => {
  const selectedLines = [
    { text: "triangular matrix. Finally,", rect: [220, 113, 301, 122] },
    {
      text: "This work was supported by a research foundation under two grants.",
      rect: [221, 104, 301, 111],
    },
    {
      text: "The authors are with a research institute and can be contacted by email.",
      rect: [221, 95, 301, 102],
    },
    {
      text: "Their institutional address appears at the bottom of the page.",
      rect: [221, 86, 301, 93],
    },
    {
      text: "the solution x is obtained by solving two triangular systems.",
      rect: [313, 419, 558, 428],
    },
  ] as const;

  assert.equal(
    normalizeSinglePageReaderSelection(selectedLines, new Set(), [
      { text: "Page heading", rect: [56, 700, 558, 712] },
      { text: "1", rect: [300, 20, 306, 28] },
    ]),
    selectedLines.map(({ text }) => text).join(" "),
  );
});

test("keeps one smaller page-bottom line without a block rhythm", () => {
  const selectedLines = [
    { text: "The first column ends here.", rect: [56, 119, 301, 128] },
    { text: "A compact semantic line remains.", rect: [56, 82, 250, 89] },
    { text: "The second column begins here.", rect: [313, 419, 558, 428] },
  ] as const;

  assert.equal(
    normalizeSinglePageReaderSelection(selectedLines, new Set(), [
      { text: "Page heading", rect: [56, 700, 558, 712] },
      { text: "1", rect: [300, 20, 306, 28] },
    ]),
    selectedLines.map(({ text }) => text).join(" "),
  );
});

test("keeps a smaller cross-column block away from the page boundary", () => {
  const selectedLines = [
    { text: "The first column ends here.", rect: [56, 350, 301, 362] },
    { text: "A compact but semantic note", rect: [56, 315, 250, 323] },
    { text: "continues on its next line.", rect: [56, 305, 210, 313] },
    { text: "The second column begins here.", rect: [313, 650, 558, 662] },
  ] as const;

  assert.equal(
    normalizeSinglePageReaderSelection(selectedLines, new Set(), [
      { text: "Page heading", rect: [56, 700, 558, 712] },
      { text: "1", rect: [300, 20, 306, 28] },
    ]),
    "The first column ends here. A compact but semantic note continues on its next line. The second column begins here.",
  );
});

test("keeps smaller page-bottom prose without a visual body separation", () => {
  const selectedLines = [
    { text: "The first column ends here.", rect: [56, 110, 301, 122] },
    { text: "A compact continuation remains", rect: [56, 100, 250, 108] },
    { text: "part of the selected prose.", rect: [56, 90, 210, 98] },
    { text: "The second column begins here.", rect: [313, 650, 558, 662] },
  ] as const;

  assert.equal(
    normalizeSinglePageReaderSelection(selectedLines, new Set(), [
      { text: "Page heading", rect: [56, 700, 558, 712] },
      { text: "1", rect: [300, 20, 306, 28] },
    ]),
    "The first column ends here. A compact continuation remains part of the selected prose. The second column begins here.",
  );
});

test("keeps a smaller semantic block at the page top", () => {
  const selectedLines = [
    { text: "A section opening remains selected.", rect: [56, 700, 301, 712] },
    { text: "A compact summary starts here", rect: [56, 680, 250, 688] },
    { text: "and remains semantic content.", rect: [56, 670, 220, 678] },
    { text: "The second column continues.", rect: [313, 720, 558, 732] },
  ] as const;

  assert.equal(
    normalizeSinglePageReaderSelection(selectedLines, new Set(), [
      { text: "Page heading", rect: [56, 748, 558, 760] },
      { text: "1", rect: [300, 20, 306, 28] },
    ]),
    "A section opening remains selected. A compact summary starts here and remains semantic content. The second column continues.",
  );
});

test("removes a verified footnote independently of a later figure", () => {
  const selectedLines = [
    { text: "The first column ends here.", rect: [56, 119, 301, 128] },
    { text: "An unnumbered compact note", rect: [56, 82, 250, 89] },
    { text: "continues at the page bottom.", rect: [56, 73, 220, 80] },
    { text: "The second column begins here.", rect: [313, 700, 558, 712] },
    { text: "1 2 3 4 5", rect: [407, 600, 535, 612] },
    {
      text: "Fig. 7: Example of a later floating object.",
      rect: [313, 560, 558, 572],
    },
    {
      text: "The next paragraph remains selected.",
      rect: [313, 480, 558, 492],
    },
  ] as const;

  assert.equal(
    normalizeSinglePageReaderSelection(selectedLines, new Set(), [
      { text: "Page heading", rect: [56, 700, 558, 712] },
      { text: "1", rect: [300, 20, 306, 28] },
    ]),
    "The first column ends here. The second column begins here. 1 2 3 4 5 Fig. 7: Example of a later floating object. The next paragraph remains selected.",
  );
});

test("uses body text before a footnote to preserve a later prose fragment", () => {
  const selectedLines = [
    { text: "The first column ends here.", rect: [56, 119, 301, 128] },
    { text: "An unnumbered compact note", rect: [56, 82, 250, 89] },
    { text: "continues at the page bottom", rect: [56, 73, 220, 80] },
    { text: "This partial continuation", rect: [313, 700, 558, 712] },
    { text: "1 2 3 4 5", rect: [407, 600, 535, 612] },
    {
      text: "Fig. 7: Example of a later floating object.",
      rect: [313, 560, 558, 572],
    },
    { text: "continues after the figure.", rect: [313, 480, 558, 492] },
  ] as const;

  assert.equal(
    normalizeSinglePageReaderSelection(selectedLines, new Set(), [
      { text: "Page heading", rect: [56, 700, 558, 712] },
      { text: "1", rect: [300, 20, 306, 28] },
    ]),
    "The first column ends here. This partial continuation 1 2 3 4 5 Fig. 7: Example of a later floating object. continues after the figure.",
  );
});

test("keeps full-size numbered content before a cross-column selection", () => {
  const selectedLines = [
    { text: "The procedure uses", rect: [220, 119, 301, 128] },
    { text: "1", rect: [56, 100, 62, 109] },
    { text: "iteration before convergence.", rect: [67, 100, 280, 109] },
    {
      text: "The result remains valid.",
      rect: [313, 419, 520, 428],
    },
  ] as const;

  assert.equal(
    normalizeSinglePageReaderSelection(selectedLines),
    "The procedure uses 1 iteration before convergence. The result remains valid.",
  );
});

test("uses the same cross-column block rule for tables and algorithms", () => {
  const cases = [
    [
      { text: "Assume", rect: [0, 42, 205, 54] },
      { text: "TABLE II", rect: [470, 700, 550, 712] },
      { text: "RUNTIME COMPARISON", rect: [390, 680, 625, 692] },
      { text: "Method CPU GPU", rect: [350, 660, 700, 672] },
      { text: "Baseline 21.4 8.3", rect: [350, 640, 700, 652] },
      { text: "that columns 6", rect: [234, 560, 420, 572] },
    ],
    [
      { text: "Assume", rect: [0, 42, 205, 54] },
      { text: "1 for threads in parallel do", rect: [407, 700, 700, 712] },
      { text: "2 x = A(i,:);", rect: [430, 680, 590, 692] },
      {
        text: "Algorithm 4: Pipeline mode of fast factorization with pivot check.",
        rect: [234, 640, 737, 652],
      },
      { text: "that columns 6", rect: [234, 560, 420, 572] },
    ],
  ] as const;

  for (const selectedLines of cases) {
    assert.equal(
      normalizeSinglePageReaderSelection(selectedLines),
      "Assume that columns 6",
    );
  }
});

test("keeps partial body prose before a later cross-column figure", () => {
  const selectedLines = [
    { text: "Assume", rect: [0, 42, 205, 54] },
    { text: "that columns 6", rect: [234, 700, 737, 712] },
    { text: "1 2 3 4 5 6 7 8 9 10", rect: [407, 600, 735, 612] },
    {
      text: "Fig. 7: Example of re-pivoting on row 6.",
      rect: [234, 560, 737, 572],
    },
    {
      text: "The next paragraph remains selected.",
      rect: [234, 480, 737, 492],
    },
  ] as const;

  assert.equal(
    normalizeSinglePageReaderSelection(selectedLines),
    selectedLines.map(({ text }) => text).join(" "),
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

test("removes every consecutive floating object before partial prose", () => {
  const firstPageText =
    "“Div count” and “Mul count” denote the division and multiplication task num-";
  const nextPageLines = [
    {
      text: "LU task list Level 0 Level n Data dependency graph result",
      rect: [165, 700, 730, 712],
    },
    {
      text: "Figure 4: Levelized LU factorization task list.",
      rect: [235, 620, 655, 632],
    },
    {
      text: ">ĠĠu ĐŽŽYĥ >ĠĠu 6 >ĠĠu Ŷ u Ž d ŁJĐĞ dĂ&U ŽYŝ ŝ ĐŽŽYĥ dh6, dhŶ",
      rect: [242, 500, 735, 512],
    },
    {
      text: "Figure 5: GPU data structure for the LU factorization task list.",
      rect: [160, 400, 735, 412],
    },
    {
      text: "bers in the current task level.",
      rect: [160, 310, 445, 322],
    },
  ] as const;
  const nextPageText = nextPageLines.map(({ text }) => text).join(" ");

  assert.equal(
    normalizeReaderSelection(`${firstPageText} ${nextPageText}`, {
      firstPageText,
      nextPageText,
      nextPageLines,
    }),
    `${firstPageText} bers in the current task level.`,
  );
});

test("keeps semantic prose between separate floating objects", () => {
  const firstPageText = "The selection continues across the page break";
  const nextPageLines = [
    { text: "Thread 1 Thread 2", rect: [120, 700, 480, 712] },
    {
      text: "Figure 3: GPU memory architecture.",
      rect: [48, 660, 360, 672],
    },
    {
      text: "This paragraph must remain selected.",
      rect: [48, 580, 518, 592],
    },
    { text: "CPU 1 CPU 2", rect: [120, 500, 480, 512] },
    {
      text: "Figure 4: CPU memory architecture.",
      rect: [48, 460, 360, 472],
    },
    {
      text: "The final paragraph also remains selected.",
      rect: [48, 380, 518, 392],
    },
  ] as const;
  const nextPageText = nextPageLines.map(({ text }) => text).join(" ");

  assert.equal(
    normalizeReaderSelection(`${firstPageText} ${nextPageText}`, {
      firstPageText,
      nextPageText,
      nextPageLines,
    }),
    `${firstPageText} This paragraph must remain selected. CPU 1 CPU 2 Figure 4: CPU memory architecture. The final paragraph also remains selected.`,
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

test("removes an ACM journal footer at the verified first-page boundary", () => {
  const firstPageLines = [
    {
      text: "The fill-in factor for circuit matrices stays remarkably low as compared to",
      rect: [55, 88, 558, 108],
    },
    {
      text: "matrices from other applications, even though the BTF form is exploited for",
      rect: [55, 60, 558, 80],
    },
    {
      text: "ACM Transactions on Mathematical Software, Vol. 37, No. 3, Article 36, Pub. date: September 2010.",
      rect: [55, 37, 510, 49],
    },
  ] as const;
  const nextPageLines = [
    {
      text: "all matrices in this experiment. Very few circuit matrices experience as much",
      rect: [55, 700, 558, 720],
    },
    {
      text: "fill-in as 2D or 3D meshes.",
      rect: [55, 672, 280, 692],
    },
  ] as const;
  const nextPageHeader = {
    text: "Algorithm 907: KLU, A Direct Sparse Solver for Circuit Simulation Problems · 36: 5",
    rect: [55, 744, 558, 760],
  } as const;
  const nextPageFooter = {
    text: firstPageLines.at(-1)!.text,
    rect: [110, 37, 565, 49],
  } as const;
  const firstPageText = firstPageLines.map(({ text }) => text).join(" ");
  const nextPageText = nextPageLines.map(({ text }) => text).join(" ");
  const nextPageRects = [
    nextPageHeader.rect,
    ...nextPageLines.map(({ rect }) => rect),
  ];
  const annotation = {
    text: `${firstPageText} ${nextPageText}`,
    position: {
      pageIndex: 4,
      rects: firstPageLines.map(({ rect }) => rect),
      nextPageRects,
    },
  };
  const reader = {
    _internalReader: {
      _lastView: {
        _selectionRanges: [
          {
            pageIndex: 4,
            anchorOffset: 0,
            headOffset: firstPageLines.length,
            text: firstPageText,
            position: { pageIndex: 4, rects: annotation.position.rects },
          },
          {
            pageIndex: 5,
            anchorOffset: 0,
            headOffset: nextPageLines.length + 1,
            text: nextPageText,
            position: {
              pageIndex: 5,
              rects: annotation.position.nextPageRects,
            },
          },
        ],
        _pdfPages: {
          4: {
            chars: firstPageLines.map(({ text, rect }) => ({
              c: text,
              inlineRect: rect,
              lineBreakAfter: true,
            })),
          },
          5: {
            chars: [
              {
                c: nextPageHeader.text,
                ignorable: true,
                inlineRect: nextPageHeader.rect,
                lineBreakAfter: true,
              },
              ...nextPageLines.map(({ text, rect }) => ({
                c: text,
                inlineRect: rect,
                lineBreakAfter: true,
              })),
              {
                c: nextPageFooter.text,
                inlineRect: nextPageFooter.rect,
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
    [...firstPageLines.slice(0, -1), ...nextPageLines]
      .map(({ text }) => text)
      .join(" "),
  );
});

test("removes an ACM running header selected across a page boundary", () => {
  const firstPageLine = {
    text: "The third step is replaced with a",
    rect: [55, 60, 558, 80],
  } as const;
  const nextPageHeader = [
    { text: "36: 6", rect: [55, 744, 92, 759] },
    {
      text: "\u00b7 T. A. Davis and E. Palamadai Natarajan",
      rect: [200, 744, 455, 759],
    },
  ] as const;
  const nextPageLine = {
    text: "simpler left-looking method that does not perform partial pivoting.",
    rect: [55, 700, 558, 720],
  } as const;
  const nextPageText = [...nextPageHeader, nextPageLine]
    .map(({ text }) => text)
    .join(" ");
  const annotation = {
    text: `${firstPageLine.text} ${nextPageText}`,
    position: {
      pageIndex: 4,
      rects: [firstPageLine.rect],
      nextPageRects: [...nextPageHeader, nextPageLine].map(({ rect }) => rect),
    },
  };
  const firstPageChars = [
    {
      c: "Algorithm 907: KLU, A Direct Sparse Solver for Circuit Simulation Problems",
      inlineRect: [55, 744, 520, 759],
      lineBreakAfter: true,
    },
    {
      c: firstPageLine.text,
      inlineRect: firstPageLine.rect,
      lineBreakAfter: true,
    },
    {
      c: "ACM Transactions on Mathematical Software, Vol. 37, No. 3, Article 36, Pub. date: September 2010.",
      inlineRect: [110, 37, 565, 49],
      lineBreakAfter: true,
    },
  ];
  const nextPageChars = [
    ...nextPageHeader,
    nextPageLine,
    {
      text: "ACM Transactions on Mathematical Software, Vol. 37, No. 3, Article 36, Pub. date: September 2010.",
      rect: [55, 37, 510, 49],
    },
  ].map(({ text, rect }) => ({
    c: text,
    inlineRect: rect,
    lineBreakAfter: true,
  }));
  const reader = {
    _internalReader: {
      _lastView: {
        _selectionRanges: [
          {
            pageIndex: 4,
            anchorOffset: 1,
            headOffset: 2,
            text: firstPageLine.text,
            position: { pageIndex: 4, rects: annotation.position.rects },
          },
          {
            pageIndex: 5,
            anchorOffset: 0,
            headOffset: nextPageHeader.length + 1,
            text: nextPageText,
            position: {
              pageIndex: 5,
              rects: annotation.position.nextPageRects,
            },
          },
        ],
        _pdfPages: {
          4: { chars: firstPageChars },
          5: { chars: nextPageChars },
        },
      },
    },
  };

  assert.equal(
    normalizeReaderAnnotationSelection(reader, annotation),
    `${firstPageLine.text} ${nextPageLine.text}`,
  );
});

test("keeps a semantic heading at the top of the next page", () => {
  const firstPageText = "The preceding discussion ends here.";
  const nextPageLines = [
    { text: "Implementation details", rect: [55, 744, 250, 759] },
    {
      text: "the implementation uses a sparse left-looking method.",
      rect: [55, 700, 558, 720],
    },
  ] as const;
  const nextPageText = nextPageLines.map(({ text }) => text).join(" ");

  assert.equal(
    normalizeReaderSelection(`${firstPageText} ${nextPageText}`, {
      firstPageText,
      firstPageLines: [{ text: firstPageText, rect: [55, 60, 558, 80] }],
      nextPageText,
      nextPageLines,
      nextPageDocumentLines: [
        ...nextPageLines,
        { text: "Journal footer", rect: [55, 37, 250, 49] },
      ],
    }),
    `${firstPageText} ${nextPageText}`,
  );
});

test("removes structurally verified cross-page furniture without publisher text", () => {
  const firstPageText =
    "The factorization argument continues through Unrelated running footer";
  const nextPageText = "the next page without a semantic break.";

  assert.equal(
    normalizeReaderSelection(`${firstPageText} ${nextPageText}`, {
      firstPageText,
      firstPageLines: [
        {
          text: "The factorization argument continues through",
          rect: [55, 60, 420, 80],
        },
        {
          text: "Unrelated running footer",
          rect: [55, 37, 260, 49],
        },
      ],
      firstPageDocumentLines: [
        {
          text: "Earlier body text on the same page.",
          rect: [55, 700, 420, 720],
        },
        {
          text: "The factorization argument continues through",
          rect: [55, 60, 420, 80],
        },
        {
          text: "Unrelated running footer",
          rect: [55, 37, 260, 49],
        },
      ],
      nextPageText,
      nextPageLines: [
        {
          text: nextPageText,
          rect: [55, 700, 430, 720],
        },
      ],
      nextPageDocumentLines: [
        {
          text: nextPageText,
          rect: [55, 700, 430, 720],
        },
        {
          text: "Unrelated running footer",
          rect: [55, 37, 260, 49],
        },
      ],
    }),
    "The factorization argument continues through the next page without a semantic break.",
  );
});

test("keeps small semantic text without repeated fixed page furniture evidence", () => {
  const semanticLine = "A relevant compact annotation";
  const firstPageText = `The factorization argument includes ${semanticLine}`;
  const nextPageText = "the annotation before continuing on the next page.";
  const layout = {
    firstPageText,
    firstPageLines: [
      {
        text: "The factorization argument includes",
        rect: [55, 60, 420, 80] as const,
      },
      { text: semanticLine, rect: [55, 37, 260, 49] as const },
    ],
    firstPageDocumentLines: [
      {
        text: "Earlier body text on the same page.",
        rect: [55, 700, 420, 720] as const,
      },
      {
        text: "The factorization argument includes",
        rect: [55, 60, 420, 80] as const,
      },
      { text: semanticLine, rect: [55, 37, 260, 49] as const },
    ],
    nextPageText,
    nextPageLines: [{ text: nextPageText, rect: [55, 700, 430, 720] as const }],
    nextPageDocumentLines: [
      { text: nextPageText, rect: [55, 700, 430, 720] as const },
      {
        text: "Different running footer",
        rect: [55, 37, 260, 49] as const,
      },
    ],
  };

  assert.equal(
    normalizeReaderSelection(`${firstPageText} ${nextPageText}`, layout),
    `${firstPageText} ${nextPageText}`,
  );
  assert.equal(
    normalizeReaderSelection(`${firstPageText} ${nextPageText}`, {
      ...layout,
      nextPageDocumentLines: [
        layout.nextPageLines[0],
        { text: semanticLine, rect: [55, 300, 260, 312] },
      ],
    }),
    `${firstPageText} ${nextPageText}`,
  );
});

test("keeps ACM publication metadata outside the verified first-page tail", () => {
  const footer =
    "ACM Transactions on Mathematical Software, Vol. 37, No. 3, Article 36, Pub. date: September 2010.";
  const firstPageText = `${footer} The bibliography discussion continues.`;
  const nextPageText = "The next page compares the citation formats.";

  assert.equal(
    normalizeReaderSelection(`${firstPageText} ${nextPageText}`, {
      firstPageText,
      firstPageLines: [
        { text: footer, rect: [55, 56, 510, 68] },
        {
          text: "The bibliography discussion continues.",
          rect: [55, 500, 330, 520],
        },
      ],
      firstPageDocumentLines: [
        {
          text: "Earlier body text on the same page.",
          rect: [55, 700, 410, 720],
        },
        { text: footer, rect: [55, 56, 510, 68] },
        {
          text: "The bibliography discussion continues.",
          rect: [55, 500, 330, 520],
        },
      ],
      nextPageText,
      nextPageLines: [
        {
          text: nextPageText,
          rect: [55, 708, 410, 720],
        },
      ],
      nextPageDocumentLines: [
        {
          text: nextPageText,
          rect: [55, 708, 410, 720],
        },
        { text: footer, rect: [110, 56, 565, 68] },
      ],
    }),
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

test("keeps a leading body question before a later floating object", () => {
  const firstPageText = "The previous discussion continues.";
  const nextPageLines = [
    {
      text: "Does the same conclusion hold?",
      rect: [48, 716, 518, 728],
    },
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
