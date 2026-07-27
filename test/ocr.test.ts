import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  OCR_DEVELOPER_INSTRUCTIONS,
  OCR_PROMPT_VERSION,
  OCR_USER_PROMPT,
  buildModelOcrRequest,
  parseModelOcrResponse,
} from "../src/ocr/modelOcr";
import {
  assertPngDataUrlWithinLimit,
  computePixelCrop,
  createDefaultMineruImageFileAccess,
  createOcrCacheKey,
  cropMineruImageSelection,
  detectSupportedImageMimeType,
  inverseRotateSelectionBox,
  loadMineruImageIndex,
  resolveMineruImageSelection,
  type MineruImageFileAccess,
  type MineruImageIndex,
} from "../src/ocr/mineruImages";

const PNG_SIGNATURE = Uint8Array.of(
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
);

test("loads every MinerU content-list entry with a valid image mapping", async () => {
  const fixture = await createMineruFixture([
    {
      type: "text",
      page_idx: 0,
      bbox: [10, 10, 90, 90],
      text: "ordinary paper text is not an OCR image candidate",
    },
    {
      type: "table",
      img_path: "images/figure.png",
      page_idx: 1,
      bbox: [100, 200, 500, 600],
    },
  ]);
  try {
    const index = await loadMineruImageIndex(fixture.root, fixture.access);
    assert.equal(index.blocks.length, 1);
    assert.deepEqual(index.blocks[0], {
      sourceIndex: 1,
      pageIndex: 1,
      bbox: [100, 200, 500, 600],
      relativePath: "images/figure.png",
      absolutePath: await realpath(fixture.imagePath),
    });
    assert.equal(
      index.contentListSha256,
      createHash("sha256").update(fixture.contentListBytes).digest("hex"),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("rejects unsafe, missing, and malformed MinerU image mappings", async () => {
  const traversal = await createMineruFixture(
    [
      {
        img_path: "../outside.png",
        page_idx: 0,
        bbox: [0, 0, 100, 100],
      },
    ],
    { createImage: false },
  );
  try {
    await assert.rejects(
      loadMineruImageIndex(traversal.root, traversal.access),
      /path is unsafe/,
    );
  } finally {
    await traversal.cleanup();
  }

  const missing = await createMineruFixture(
    [
      {
        img_path: "images/missing.png",
        page_idx: 0,
        bbox: [0, 0, 100, 100],
      },
    ],
    { createImage: false },
  );
  try {
    await assert.rejects(
      loadMineruImageIndex(missing.root, missing.access),
      /Required MinerU regular is missing/,
    );
  } finally {
    await missing.cleanup();
  }

  const malformed = await createMineruFixture([
    {
      img_path: "images/figure.png",
      page_idx: 0,
      bbox: [100, 100, 100, 200],
    },
  ]);
  try {
    await assert.rejects(
      loadMineruImageIndex(malformed.root, malformed.access),
      /positive width and height/,
    );
  } finally {
    await malformed.cleanup();
  }
});

test("rejects a canonical image path outside the validated MinerU cache", async () => {
  const contentList = new TextEncoder().encode(
    JSON.stringify([
      {
        img_path: "images/figure.png",
        page_idx: 0,
        bbox: [0, 0, 100, 100],
      },
    ]),
  );
  const access: MineruImageFileAccess = {
    async read(path) {
      assert.match(path, /content_list[.]json$/);
      return contentList;
    },
    async stat(path) {
      return { type: path === "C:\\cache" ? "directory" : "regular" };
    },
    async canonicalize(path) {
      if (path === "C:\\cache") return path;
      if (path.endsWith("content_list.json")) {
        return "C:\\cache\\content_list.json";
      }
      return "C:\\outside\\figure.png";
    },
  };
  await assert.rejects(
    loadMineruImageIndex("C:\\cache", access),
    /escapes the validated cache/,
  );
});

test("uses Zotero 7 pathToFile normalization and rejects symlink ancestors", async () => {
  const previousIO = (globalThis as any).IOUtils;
  const previousZotero = (globalThis as any).Zotero;
  const symlinks = new Set<string>();
  const parentPaths = new Map<string, string | null>([
    ["C:\\cache\\images\\figure.png", "C:\\cache\\images"],
    ["C:\\cache\\images", "C:\\cache"],
    ["C:\\cache", "C:\\"],
    ["C:\\", null],
  ]);
  class RuntimeFile {
    constructor(public path: string) {}

    normalize() {
      this.path = this.path.replace("\\.\\", "\\");
    }

    isSymlink() {
      return symlinks.has(this.path);
    }

    equals(other: RuntimeFile) {
      return this.path === other.path;
    }

    get parent(): RuntimeFile | null {
      const parent = parentPaths.get(this.path);
      return parent ? new RuntimeFile(parent) : null;
    }
  }
  (globalThis as any).IOUtils = {
    async read() {
      return PNG_SIGNATURE;
    },
    async stat() {
      return { type: "regular" };
    },
  };
  (globalThis as any).Zotero = {
    File: {
      pathToFile(path: string) {
        return new RuntimeFile(path);
      },
    },
  };
  try {
    const access = createDefaultMineruImageFileAccess();
    assert.equal(
      await access.canonicalize("C:\\cache\\.\\images\\figure.png"),
      "C:\\cache\\images\\figure.png",
    );
    symlinks.add("C:\\cache\\images");
    await assert.rejects(
      access.canonicalize("C:\\cache\\images\\figure.png"),
      /does not accept symbolic-link paths/,
    );
  } finally {
    (globalThis as any).IOUtils = previousIO;
    (globalThis as any).Zotero = previousZotero;
  }
});

test("revalidates content_list containment before reading the selected image", async () => {
  const contentList = new TextEncoder().encode(
    JSON.stringify([
      {
        page_idx: 0,
        bbox: [100, 100, 900, 900],
        img_path: "images/figure.png",
      },
    ]),
  );
  let contentListCanonicalizations = 0;
  const access: MineruImageFileAccess = {
    async read(path) {
      if (path.endsWith("content_list.json")) return contentList;
      return PNG_SIGNATURE;
    },
    async stat(path) {
      return { type: path === "C:\\cache" ? "directory" : "regular" };
    },
    async canonicalize(path) {
      if (path === "C:\\cache") return path;
      if (path.endsWith("content_list.json")) {
        contentListCanonicalizations += 1;
        return contentListCanonicalizations === 1
          ? "C:\\cache\\content_list.json"
          : "C:\\outside\\content_list.json";
      }
      return "C:\\cache\\images\\figure.png";
    },
  };
  const index = await loadMineruImageIndex("C:\\cache", access);
  const selection = resolveMineruImageSelection(
    index,
    0,
    [200, 200, 800, 800],
    0,
  );
  await assert.rejects(
    cropMineruImageSelection(index, selection, {} as Document, {
      fileAccess: access,
    }),
    /escapes the validated cache/,
  );
});

test("maps page selections through every supported inverse rotation", () => {
  assert.deepEqual(
    inverseRotateSelectionBox([200, 300, 300, 400], 0),
    [200, 300, 300, 400],
  );
  assert.deepEqual(
    inverseRotateSelectionBox([600, 200, 700, 300], 90),
    [200, 300, 300, 400],
  );
  assert.deepEqual(
    inverseRotateSelectionBox([700, 600, 800, 700], 180),
    [200, 300, 300, 400],
  );
  assert.deepEqual(
    inverseRotateSelectionBox([300, 700, 400, 800], 270),
    [200, 300, 300, 400],
  );
});

test("requires exactly one containing MinerU image block", () => {
  const index = imageIndex([
    {
      sourceIndex: 0,
      pageIndex: 1,
      bbox: [100, 200, 500, 600],
      relativePath: "images/a.png",
      absolutePath: "C:\\cache\\images\\a.png",
    },
  ]);
  const selection = resolveMineruImageSelection(
    index,
    1,
    [200, 300, 300, 400],
    0,
  );
  assert.deepEqual(selection.sourceSelection, [200, 300, 300, 400]);
  assert.deepEqual(selection.crop, [0.25, 0.25, 0.5, 0.5]);

  assert.throws(
    () => resolveMineruImageSelection(index, 1, [700, 700, 800, 800], 0),
    /not contained in a MinerU image block/,
  );

  const ambiguous = imageIndex([
    ...index.blocks,
    {
      sourceIndex: 1,
      pageIndex: 1,
      bbox: [150, 250, 350, 450],
      relativePath: "images/b.png",
      absolutePath: "C:\\cache\\images\\b.png",
    },
  ]);
  assert.throws(
    () => resolveMineruImageSelection(ambiguous, 1, [200, 300, 300, 400], 0),
    /matches 2 MinerU image blocks/,
  );
});

test("computes an inclusive pixel crop and bounded PNG output size", () => {
  assert.deepEqual(computePixelCrop(1_000, 500, [0.1, 0.2, 0.9, 0.8], 500), {
    source: [100, 100, 800, 300],
    output: [500, 188],
  });
  assert.deepEqual(computePixelCrop(100, 80, [0.001, 0.001, 0.999, 0.999]), {
    source: [0, 0, 100, 80],
    output: [100, 80],
  });
});

test("detects JPEG, PNG, and WebP by bytes instead of extension", () => {
  assert.equal(detectSupportedImageMimeType(PNG_SIGNATURE), "image/png");
  assert.equal(
    detectSupportedImageMimeType(Uint8Array.of(0xff, 0xd8, 0xff, 0xdb)),
    "image/jpeg",
  );
  assert.equal(
    detectSupportedImageMimeType(
      new TextEncoder().encode("RIFFxxxxWEBPpayload"),
    ),
    "image/webp",
  );
  assert.throws(
    () => detectSupportedImageMimeType(new TextEncoder().encode("<svg/>")),
    /not a supported JPEG, PNG, or WebP/,
  );
});

test("enforces a hard PNG byte limit without changing image formats", () => {
  assert.doesNotThrow(() =>
    assertPngDataUrlWithinLimit("data:image/png;base64,AAAA", 3),
  );
  assert.throws(
    () => assertPngDataUrlWithinLimit("data:image/png;base64,AAAA", 2),
    /exceeds the 2 bytes input limit/,
  );
  assert.throws(
    () => assertPngDataUrlWithinLimit("data:image/jpeg;base64,AAAA", 3),
    /invalid PNG data URL/,
  );
});

test("crops local MinerU image bytes through a newly created Canvas", async () => {
  const fixture = await createMineruFixture([
    {
      img_path: "images/figure.png",
      page_idx: 0,
      bbox: [100, 200, 500, 600],
    },
  ]);
  const drawCalls: unknown[][] = [];
  const runtimeDocument = createCanvasRuntime(drawCalls);
  try {
    const index = await loadMineruImageIndex(fixture.root, fixture.access);
    const selection = resolveMineruImageSelection(
      index,
      0,
      [200, 300, 300, 400],
      0,
    );
    const cropped = await cropMineruImageSelection(
      index,
      selection,
      runtimeDocument,
      { fileAccess: fixture.access },
    );
    assert.equal(cropped.dataUrl, "data:image/png;base64,Y3JvcA==");
    assert.equal(
      cropped.imageSha256,
      createHash("sha256").update(PNG_SIGNATURE).digest("hex"),
    );
    assert.deepEqual(cropped.sourcePixelSize, [800, 400]);
    assert.deepEqual(cropped.outputPixelSize, [200, 100]);
    assert.equal(cropped.sourceMimeType, "image/png");
    assert.equal(drawCalls.length, 1);
    assert.deepEqual(
      drawCalls[0].slice(1),
      [200, 100, 200, 100, 0, 0, 200, 100],
    );
  } finally {
    await fixture.cleanup();
  }
});

test("refuses to crop after content_list.json changes", async () => {
  const fixture = await createMineruFixture([
    {
      img_path: "images/figure.png",
      page_idx: 0,
      bbox: [100, 200, 500, 600],
    },
  ]);
  try {
    const index = await loadMineruImageIndex(fixture.root, fixture.access);
    const selection = resolveMineruImageSelection(
      index,
      0,
      [200, 300, 300, 400],
      0,
    );
    await writeFile(fixture.contentListPath, "[]");
    await assert.rejects(
      cropMineruImageSelection(index, selection, createCanvasRuntime([]), {
        fileAccess: fixture.access,
      }),
      /content_list[.]json changed/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("creates a stable OCR cache key from every identity component", async () => {
  const base = {
    attachmentKey: "ABCD1234",
    imageSha256: "a".repeat(64),
    contentListSha256: "b".repeat(64),
    crop: [0.1, 0.2, 0.3, 0.4] as const,
    model: "gpt-5.4",
    effort: "medium",
    promptVersion: OCR_PROMPT_VERSION,
  };
  const first = await createOcrCacheKey(base);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(await createOcrCacheKey({ ...base }), first);
  assert.notEqual(await createOcrCacheKey({ ...base, effort: "high" }), first);
  assert.notEqual(
    await createOcrCacheKey({
      ...base,
      contentListSha256: "c".repeat(64),
    }),
    first,
  );
});

test("builds one provider-independent OCR request with a high-detail image", () => {
  const request = buildModelOcrRequest({
    imageDataUrl: "data:image/png;base64,iVBORw==",
  });
  assert.equal(request.instructions, OCR_DEVELOPER_INSTRUCTIONS);
  assert.equal(request.prompt, OCR_USER_PROMPT);
  assert.deepEqual(request.image, {
    dataUrl: "data:image/png;base64,iVBORw==",
    detail: "high",
  });
  assert.equal(request.webSearch, undefined);
  assert.equal(
    (request as Record<string, unknown>).max_output_tokens,
    undefined,
  );
  assert.equal((request as Record<string, unknown>).max_tool_calls, undefined);
});

test("reflows visual OCR wrapping without flattening semantic structure", () => {
  assert.equal(OCR_PROMPT_VERSION, "3");
  assert.match(
    OCR_DEVELOPER_INSTRUCTIONS,
    /Return text in semantic reading units, not raw visual rows/u,
  );
  assert.match(
    OCR_DEVELOPER_INSTRUCTIONS,
    /Join line breaks caused only by visual wrapping inside one coherent label, phrase, or sentence with a single space/u,
  );
  assert.match(
    OCR_DEVELOPER_INSTRUCTIONS,
    /Preserve line breaks only between distinct labels, list items, table rows or cells, paragraphs, captions, and formula lines/u,
  );
  assert.doesNotMatch(
    OCR_DEVELOPER_INSTRUCTIONS,
    /Preserve visible line breaks/u,
  );
});

test("releases failed OCR ownership before publishing the retryable error state", async () => {
  const source = await readFile(
    new URL("../src/ocr/controller.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(
    "export async function startImageTextRecognition",
  );
  const end = source.indexOf(
    "export function cancelImageTextRecognition",
    start,
  );
  const lifecycle = source.slice(start, end);
  const release = lifecycle.indexOf(
    "activeRecognitions.delete(params.attachmentItemID)",
  );
  const terminalError = lifecycle.lastIndexOf('phase: "error"');

  assert.ok(release >= 0 && terminalError >= 0);
  assert.ok(
    release < terminalError,
    "the error refresh must observe that OCR is no longer active",
  );
});

test("strictly parses OCR JSON while preserving meaningful line breaks", () => {
  assert.equal(
    parseModelOcrResponse('{"text":"first line\\nE = mc²"}'),
    "first line\nE = mc²",
  );
  assert.equal(
    parseModelOcrResponse('{"text":"  label\\nvalue  "}'),
    "  label\nvalue  ",
  );
  assert.throws(
    () => parseModelOcrResponse('```json\\n{"text":"x"}\\n```'),
    /not valid JSON/,
  );
  assert.throws(
    () => parseModelOcrResponse('{"text":"x","translation":"y"}'),
    /only the "text" field/,
  );
  assert.throws(
    () => parseModelOcrResponse('{"text":"   "}'),
    /no visible text/,
  );
});

function imageIndex(blocks: MineruImageIndex["blocks"]): MineruImageIndex {
  return {
    cacheDir: "C:\\cache",
    contentListPath: "C:\\cache\\content_list.json",
    contentListSha256: "a".repeat(64),
    blocks,
  };
}

async function createMineruFixture(
  contentList: unknown[],
  options: { createImage?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "paper-translate-ocr-"));
  const contentListPath = join(root, "content_list.json");
  const imagePath = join(root, "images", "figure.png");
  const contentListBytes = new TextEncoder().encode(
    JSON.stringify(contentList),
  );
  await writeFile(contentListPath, contentListBytes);
  if (options.createImage !== false) {
    await mkdir(dirname(imagePath), { recursive: true });
    await writeFile(imagePath, PNG_SIGNATURE);
  }
  const access: MineruImageFileAccess = {
    read: (path) => readFile(path),
    async stat(path) {
      const info = await stat(path);
      return {
        type: info.isDirectory()
          ? "directory"
          : info.isFile()
            ? "regular"
            : "other",
      };
    },
    canonicalize: (path) => realpath(path),
  };
  return {
    root,
    contentListPath,
    contentListBytes,
    imagePath,
    access,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function createCanvasRuntime(drawCalls: unknown[][]): Document {
  class RuntimeImage {
    naturalWidth = 800;
    naturalHeight = 400;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;

    set src(value: string) {
      assert.match(value, /^data:image\/png;base64,/);
      queueMicrotask(() => this.onload?.());
    }
  }
  const canvas = {
    width: 0,
    height: 0,
    getContext(type: string) {
      assert.equal(type, "2d");
      return {
        drawImage(...args: unknown[]) {
          drawCalls.push(args);
        },
      };
    },
    toDataURL(type: string) {
      assert.equal(type, "image/png");
      return "data:image/png;base64,Y3JvcA==";
    },
  };
  return {
    defaultView: {
      Image: RuntimeImage,
      btoa(value: string) {
        return Buffer.from(value, "binary").toString("base64");
      },
    },
    createElement(name: string) {
      assert.equal(name, "canvas");
      return canvas;
    },
  } as unknown as Document;
}
