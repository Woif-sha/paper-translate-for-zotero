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
): string {
  const selectedText = selectedLines
    .map(({ text }, index) =>
      index < selectedLines.length - 1
        ? `${text}${unspacedLineBreaks.has(index) ? "" : " "}`
        : text,
    )
    .join("");
  const rects = selectedLines.map(({ rect }) => rect);
  const chars = selectedLines.flatMap(({ text }, index) => [
    {
      c: text,
      spaceAfter:
        index < selectedLines.length - 1 && !unspacedLineBreaks.has(index),
    },
    { c: "", ignorable: true, lineBreakAfter: true },
  ]);
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
            anchorOffset: 0,
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
    normalizeSinglePageReaderSelection(selectedLines),
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
    normalizeSinglePageReaderSelection(selectedLines),
    "any information the reliability model might need additional data.",
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
