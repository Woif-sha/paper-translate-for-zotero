const CONTENT_LIST_FILE_NAME = "content_list.json";
const COORDINATE_SCALE = 1_000;
const DEFAULT_MAXIMUM_CROP_LONG_EDGE = 2_048;
const MAXIMUM_OCR_PNG_BYTES = 20 * 1_024 * 1_024;
const CACHE_COORDINATE_PRECISION = 1_000_000;

export type MineruCoordinateBox = readonly [
  left: number,
  top: number,
  right: number,
  bottom: number,
];

export type RelativeCropBox = readonly [
  left: number,
  top: number,
  right: number,
  bottom: number,
];

export type PdfPageRotation = 0 | 90 | 180 | 270;

export type MineruImageBlock = {
  sourceIndex: number;
  pageIndex: number;
  bbox: MineruCoordinateBox;
  relativePath: string;
  absolutePath: string;
};

export type MineruImageIndex = {
  cacheDir: string;
  contentListPath: string;
  contentListSha256: string;
  blocks: readonly MineruImageBlock[];
};

export type ResolvedMineruImageSelection = {
  block: MineruImageBlock;
  pageSelection: MineruCoordinateBox;
  sourceSelection: MineruCoordinateBox;
  crop: RelativeCropBox;
};

export type CroppedMineruImage = {
  dataUrl: string;
  imageSha256: string;
  contentListSha256: string;
  crop: RelativeCropBox;
  sourcePath: string;
  sourceMimeType: SupportedImageMimeType;
  sourcePixelSize: readonly [width: number, height: number];
  outputPixelSize: readonly [width: number, height: number];
};

export type OcrCacheKeyInput = {
  attachmentKey: string;
  imageSha256: string;
  contentListSha256: string;
  crop: RelativeCropBox;
  model: string;
  effort?: string;
  promptVersion: string;
};

export type MineruImageFileAccess = {
  read(path: string): Promise<Uint8Array | ArrayBuffer>;
  stat(path: string): Promise<{ type?: string }>;
  canonicalize(path: string): Promise<string>;
};

type RuntimeIOUtils = {
  read(path: string): Promise<Uint8Array | ArrayBuffer>;
  stat(path: string): Promise<{ type?: string }>;
};

type RuntimeFile = {
  normalize(): void;
  isSymlink(): boolean;
  equals(other: RuntimeFile): boolean;
  readonly parent?: RuntimeFile | null;
  readonly path: string;
};

type RuntimeZoteroFile = {
  pathToFile(path: string): RuntimeFile;
};

type SupportedImageMimeType = "image/jpeg" | "image/png" | "image/webp";

export async function loadMineruImageIndex(
  validatedMineruCacheDir: string,
  fileAccess: MineruImageFileAccess = getDefaultFileAccess(),
): Promise<MineruImageIndex> {
  const cacheDir = validatedMineruCacheDir.trim();
  if (!cacheDir)
    throw new Error("Validated MinerU cache directory is required");
  await requirePathType(cacheDir, "directory", fileAccess);
  const canonicalCacheDir = await fileAccess.canonicalize(cacheDir);
  const contentListPath = joinPath(cacheDir, CONTENT_LIST_FILE_NAME);
  const canonicalContentListPath = await requireContainedFile(
    canonicalCacheDir,
    contentListPath,
    fileAccess,
  );
  const contentListBytes = asBytes(
    await fileAccess.read(canonicalContentListPath),
  );
  const contentListSha256 = await sha256Hex(contentListBytes);
  let contentList: unknown;
  try {
    contentList = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(contentListBytes),
    );
  } catch (error) {
    throw new Error(`MinerU content_list.json is invalid: ${String(error)}`);
  }
  if (!Array.isArray(contentList)) {
    throw new Error("MinerU content_list.json must contain an array");
  }

  const blocks: MineruImageBlock[] = [];
  for (
    let sourceIndex = 0;
    sourceIndex < contentList.length;
    sourceIndex += 1
  ) {
    const entry = contentList[sourceIndex];
    if (!isObject(entry) || !Object.hasOwn(entry, "img_path")) continue;
    const relativePath = parseRelativeImagePath(entry.img_path, sourceIndex);
    const pageIndex = parsePageIndex(entry.page_idx, sourceIndex);
    const bbox = parseCoordinateBox(entry.bbox, `entry ${sourceIndex} bbox`);
    const absolutePath = joinPath(cacheDir, ...relativePath.split("/"));
    const canonicalImagePath = await requireContainedFile(
      canonicalCacheDir,
      absolutePath,
      fileAccess,
    );
    blocks.push({
      sourceIndex,
      pageIndex,
      bbox,
      relativePath,
      absolutePath: canonicalImagePath,
    });
  }

  return {
    cacheDir: canonicalCacheDir,
    contentListPath: canonicalContentListPath,
    contentListSha256,
    blocks,
  };
}

export function resolveMineruImageSelection(
  index: MineruImageIndex,
  pageIndex: number,
  pageSelection: MineruCoordinateBox,
  rotation: PdfPageRotation,
): ResolvedMineruImageSelection {
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw new Error("OCR page index must be a non-negative integer");
  }
  const validatedSelection = parseCoordinateBox(
    pageSelection,
    "OCR page selection",
  );
  const sourceSelection = inverseRotateSelectionBox(
    validatedSelection,
    rotation,
  );
  const matches = index.blocks.filter(
    (block) =>
      block.pageIndex === pageIndex && containsBox(block.bbox, sourceSelection),
  );
  if (matches.length === 0) {
    throw new Error(
      `OCR selection on page ${pageIndex + 1} is not contained in a MinerU image block`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `OCR selection on page ${pageIndex + 1} matches ${matches.length} MinerU image blocks`,
    );
  }
  const block = matches[0];
  return {
    block,
    pageSelection: validatedSelection,
    sourceSelection,
    crop: relativeCrop(block.bbox, sourceSelection),
  };
}

export function inverseRotateSelectionBox(
  pageSelection: MineruCoordinateBox,
  rotation: PdfPageRotation,
): MineruCoordinateBox {
  const box = parseCoordinateBox(pageSelection, "OCR page selection");
  if (![0, 90, 180, 270].includes(rotation)) {
    throw new Error(`Unsupported PDF page rotation: ${String(rotation)}`);
  }
  const corners = [
    [box[0], box[1]],
    [box[2], box[1]],
    [box[0], box[3]],
    [box[2], box[3]],
  ].map(([x, y]) => inverseRotatePoint(x, y, rotation));
  const xValues = corners.map(([x]) => clampCoordinate(x));
  const yValues = corners.map(([, y]) => clampCoordinate(y));
  return [
    Math.min(...xValues),
    Math.min(...yValues),
    Math.max(...xValues),
    Math.max(...yValues),
  ];
}

export function computePixelCrop(
  imageWidth: number,
  imageHeight: number,
  crop: RelativeCropBox,
  maximumLongEdge = DEFAULT_MAXIMUM_CROP_LONG_EDGE,
): {
  source: readonly [x: number, y: number, width: number, height: number];
  output: readonly [width: number, height: number];
} {
  if (
    !Number.isInteger(imageWidth) ||
    imageWidth <= 0 ||
    !Number.isInteger(imageHeight) ||
    imageHeight <= 0
  ) {
    throw new Error("Decoded MinerU image has invalid pixel dimensions");
  }
  if (!Number.isInteger(maximumLongEdge) || maximumLongEdge <= 0) {
    throw new Error("OCR crop maximum long edge must be a positive integer");
  }
  const relative = parseRelativeCrop(crop);
  const left = Math.max(0, Math.floor(relative[0] * imageWidth));
  const top = Math.max(0, Math.floor(relative[1] * imageHeight));
  const right = Math.min(imageWidth, Math.ceil(relative[2] * imageWidth));
  const bottom = Math.min(imageHeight, Math.ceil(relative[3] * imageHeight));
  const sourceWidth = right - left;
  const sourceHeight = bottom - top;
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error("OCR image crop has no pixels");
  }
  const scale = Math.min(
    1,
    maximumLongEdge / Math.max(sourceWidth, sourceHeight),
  );
  return {
    source: [left, top, sourceWidth, sourceHeight],
    output: [
      Math.max(1, Math.round(sourceWidth * scale)),
      Math.max(1, Math.round(sourceHeight * scale)),
    ],
  };
}

export async function cropMineruImageSelection(
  index: MineruImageIndex,
  selection: ResolvedMineruImageSelection,
  runtimeDocument: Document,
  options: {
    fileAccess?: MineruImageFileAccess;
    maximumLongEdge?: number;
    signal?: AbortSignal;
  } = {},
): Promise<CroppedMineruImage> {
  const fileAccess = options.fileAccess ?? getDefaultFileAccess();
  assertNotAborted(options.signal);
  assertSelectionBelongsToIndex(index, selection);

  const canonicalContentListPath = await requireContainedFile(
    index.cacheDir,
    index.contentListPath,
    fileAccess,
  );
  const currentContentList = asBytes(
    await fileAccess.read(canonicalContentListPath),
  );
  if ((await sha256Hex(currentContentList)) !== index.contentListSha256) {
    throw new Error(
      "MinerU content_list.json changed after the OCR selection was mapped",
    );
  }
  const canonicalImagePath = await requireContainedFile(
    index.cacheDir,
    selection.block.absolutePath,
    fileAccess,
  );
  assertNotAborted(options.signal);
  const imageBytes = asBytes(await fileAccess.read(canonicalImagePath));
  const sourceMimeType = detectSupportedImageMimeType(imageBytes);
  assertExtensionMatchesMimeType(canonicalImagePath, sourceMimeType);
  const imageSha256 = await sha256Hex(imageBytes);
  assertNotAborted(options.signal);

  const decoded = await loadRuntimeImage(
    runtimeDocument,
    imageBytes,
    sourceMimeType,
    options.signal,
  );
  try {
    assertNotAborted(options.signal);
    const pixels = computePixelCrop(
      decoded.image.naturalWidth,
      decoded.image.naturalHeight,
      selection.crop,
      options.maximumLongEdge,
    );
    const canvas = runtimeDocument.createElement("canvas");
    canvas.width = pixels.output[0];
    canvas.height = pixels.output[1];
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D context is unavailable for OCR");
    context.drawImage(
      decoded.image,
      pixels.source[0],
      pixels.source[1],
      pixels.source[2],
      pixels.source[3],
      0,
      0,
      pixels.output[0],
      pixels.output[1],
    );
    const dataUrl = canvas.toDataURL("image/png");
    if (!dataUrl.startsWith("data:image/png;base64,")) {
      throw new Error("Canvas did not produce a PNG data URL for OCR");
    }
    assertPngDataUrlWithinLimit(dataUrl);
    return {
      dataUrl,
      imageSha256,
      contentListSha256: index.contentListSha256,
      crop: selection.crop,
      sourcePath: canonicalImagePath,
      sourceMimeType,
      sourcePixelSize: [
        decoded.image.naturalWidth,
        decoded.image.naturalHeight,
      ],
      outputPixelSize: pixels.output,
    };
  } finally {
    decoded.release();
  }
}

export function assertPngDataUrlWithinLimit(
  dataUrl: string,
  maximumBytes = MAXIMUM_OCR_PNG_BYTES,
): void {
  if (!Number.isInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error("OCR PNG maximum size must be a positive integer");
  }
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[1].length % 4 !== 0) {
    throw new Error("Canvas produced an invalid PNG data URL for OCR");
  }
  const padding = match[1].endsWith("==") ? 2 : match[1].endsWith("=") ? 1 : 0;
  const byteLength = (match[1].length / 4) * 3 - padding;
  if (byteLength > maximumBytes) {
    throw new Error(
      `OCR PNG crop exceeds the ${formatBinaryBytes(maximumBytes)} input limit`,
    );
  }
}

export async function createOcrCacheKey(
  input: OcrCacheKeyInput,
): Promise<string> {
  const attachmentKey = requiredCacheValue(
    input.attachmentKey,
    "attachment key",
  );
  const imageSha256 = parseSha256(input.imageSha256, "image SHA-256");
  const contentListSha256 = parseSha256(
    input.contentListSha256,
    "content-list SHA-256",
  );
  const crop = parseRelativeCrop(input.crop).map((coordinate) =>
    Math.round(coordinate * CACHE_COORDINATE_PRECISION),
  );
  const model = requiredCacheValue(input.model, "model");
  const effort =
    String(input.effort || "")
      .trim()
      .toLowerCase() || "auto";
  const promptVersion = requiredCacheValue(
    input.promptVersion,
    "OCR prompt version",
  );
  const canonical = JSON.stringify([
    "paper-translate-for-zotero-ocr-v1",
    attachmentKey,
    imageSha256,
    contentListSha256,
    crop,
    model,
    effort,
    promptVersion,
  ]);
  return sha256Hex(new TextEncoder().encode(canonical));
}

export function detectSupportedImageMimeType(
  bytes: Uint8Array,
): SupportedImageMimeType {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  throw new Error("MinerU image is not a supported JPEG, PNG, or WebP file");
}

export async function sha256Hex(
  value: Uint8Array | ArrayBuffer,
): Promise<string> {
  const bytes = asBytes(value);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto is unavailable for MinerU OCR");
  const digest = await subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseRelativeImagePath(value: unknown, sourceIndex: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`MinerU image entry ${sourceIndex} has no img_path`);
  }
  const path = value.trim().replace(/\\/g, "/");
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)
  ) {
    throw new Error(`MinerU image entry ${sourceIndex} path must be relative`);
  }
  const parts = path.split("/");
  if (
    parts.some(
      (part) => !part || part === "." || part === ".." || part.includes("\0"),
    )
  ) {
    throw new Error(`MinerU image entry ${sourceIndex} path is unsafe`);
  }
  if (!/\.(?:jpe?g|png|webp)$/i.test(parts.at(-1) || "")) {
    throw new Error(
      `MinerU image entry ${sourceIndex} is not JPEG, PNG, or WebP`,
    );
  }
  return parts.join("/");
}

function parsePageIndex(value: unknown, sourceIndex: number): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(
      `MinerU image entry ${sourceIndex} page_idx must be a non-negative integer`,
    );
  }
  return Number(value);
}

function parseCoordinateBox(
  value: unknown,
  label: string,
): MineruCoordinateBox {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value.some(
      (coordinate) =>
        typeof coordinate !== "number" ||
        !Number.isFinite(coordinate) ||
        coordinate < 0 ||
        coordinate > COORDINATE_SCALE,
    )
  ) {
    throw new Error(`${label} must contain four coordinates from 0 to 1000`);
  }
  if (value[0] >= value[2] || value[1] >= value[3]) {
    throw new Error(`${label} must have positive width and height`);
  }
  return [value[0], value[1], value[2], value[3]];
}

function parseRelativeCrop(value: unknown): RelativeCropBox {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value.some(
      (coordinate) =>
        typeof coordinate !== "number" ||
        !Number.isFinite(coordinate) ||
        coordinate < 0 ||
        coordinate > 1,
    )
  ) {
    throw new Error("OCR image crop must contain four coordinates from 0 to 1");
  }
  if (value[0] >= value[2] || value[1] >= value[3]) {
    throw new Error("OCR image crop must have positive width and height");
  }
  return [value[0], value[1], value[2], value[3]];
}

function inverseRotatePoint(
  x: number,
  y: number,
  rotation: PdfPageRotation,
): readonly [number, number] {
  switch (rotation) {
    case 0:
      return [x, y];
    case 90:
      return [y, COORDINATE_SCALE - x];
    case 180:
      return [COORDINATE_SCALE - x, COORDINATE_SCALE - y];
    case 270:
      return [COORDINATE_SCALE - y, x];
  }
}

function containsBox(
  outer: MineruCoordinateBox,
  inner: MineruCoordinateBox,
): boolean {
  return (
    inner[0] >= outer[0] &&
    inner[1] >= outer[1] &&
    inner[2] <= outer[2] &&
    inner[3] <= outer[3]
  );
}

function relativeCrop(
  imageBox: MineruCoordinateBox,
  selection: MineruCoordinateBox,
): RelativeCropBox {
  const width = imageBox[2] - imageBox[0];
  const height = imageBox[3] - imageBox[1];
  return [
    (selection[0] - imageBox[0]) / width,
    (selection[1] - imageBox[1]) / height,
    (selection[2] - imageBox[0]) / width,
    (selection[3] - imageBox[1]) / height,
  ];
}

async function loadRuntimeImage(
  runtimeDocument: Document,
  bytes: Uint8Array,
  mimeType: SupportedImageMimeType,
  signal?: AbortSignal,
): Promise<{ image: HTMLImageElement; release: () => void }> {
  const runtimeWindow = runtimeDocument.defaultView;
  if (!runtimeWindow) {
    throw new Error(
      "A live browser document is required to crop a MinerU image",
    );
  }
  const constructors = runtimeWindow as unknown as {
    Image?: typeof Image;
    btoa?: (value: string) => string;
  };
  if (!constructors.Image || !constructors.btoa) {
    throw new Error("Browser image decoding APIs are unavailable");
  }
  const image = new constructors.Image();
  const release = () => undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(abortError(signal));
      image.onload = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      image.onerror = () => {
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`Cannot decode MinerU ${mimeType} image`));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      image.src = `data:${mimeType};base64,${encodeBase64(
        bytes,
        constructors.btoa!.bind(runtimeWindow),
      )}`;
    });
    if (!image.naturalWidth || !image.naturalHeight) {
      throw new Error("Decoded MinerU image has no pixels");
    }
    return { image, release };
  } catch (error) {
    release();
    throw error;
  }
}

function encodeBase64(
  bytes: Uint8Array,
  encodeBinary: (value: string) => string,
): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return encodeBinary(binary);
}

async function requireContainedFile(
  canonicalCacheDir: string,
  path: string,
  fileAccess: MineruImageFileAccess,
): Promise<string> {
  await requirePathType(path, "regular", fileAccess);
  const canonicalPath = await fileAccess.canonicalize(path);
  if (!isStrictChildPath(canonicalCacheDir, canonicalPath)) {
    throw new Error(`MinerU image path escapes the validated cache: ${path}`);
  }
  return canonicalPath;
}

async function requirePathType(
  path: string,
  expected: "directory" | "regular",
  fileAccess: MineruImageFileAccess,
): Promise<void> {
  let stat: { type?: string };
  try {
    stat = await fileAccess.stat(path);
  } catch (error) {
    throw new Error(`Required MinerU ${expected} is missing: ${path}`);
  }
  if (stat.type !== expected) {
    throw new Error(`MinerU path is not a ${expected}: ${path}`);
  }
}

function isStrictChildPath(parent: string, child: string): boolean {
  const parentKey = comparablePath(parent);
  const childKey = comparablePath(child);
  return childKey.startsWith(`${parentKey}/`);
}

function comparablePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

function joinPath(base: string, ...parts: string[]): string {
  const separator = base.includes("\\") ? "\\" : "/";
  return [
    base.replace(/[\\/]+$/, ""),
    ...parts.map((part) => part.replace(/^[\\/]+|[\\/]+$/g, "")),
  ].join(separator);
}

function assertExtensionMatchesMimeType(
  path: string,
  mimeType: SupportedImageMimeType,
): void {
  const extension = (/[.]([^.\\/]+)$/.exec(path)?.[1] || "").toLowerCase();
  const expected =
    extension === "png"
      ? "image/png"
      : extension === "webp"
        ? "image/webp"
        : extension === "jpg" || extension === "jpeg"
          ? "image/jpeg"
          : "";
  if (expected !== mimeType) {
    throw new Error("MinerU image extension does not match its file content");
  }
}

function assertSelectionBelongsToIndex(
  index: MineruImageIndex,
  selection: ResolvedMineruImageSelection,
): void {
  const block = index.blocks.find(
    (candidate) => candidate.sourceIndex === selection.block.sourceIndex,
  );
  if (
    !block ||
    block.pageIndex !== selection.block.pageIndex ||
    block.absolutePath !== selection.block.absolutePath ||
    block.relativePath !== selection.block.relativePath ||
    !sameBox(block.bbox, selection.block.bbox)
  ) {
    throw new Error("OCR selection does not belong to this MinerU image index");
  }
  const sourceSelection = parseCoordinateBox(
    selection.sourceSelection,
    "OCR source selection",
  );
  if (
    !containsBox(block.bbox, sourceSelection) ||
    !sameBox(relativeCrop(block.bbox, sourceSelection), selection.crop)
  ) {
    throw new Error("OCR crop does not match its MinerU image selection");
  }
}

function sameBox(left: readonly number[], right: readonly number[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function clampCoordinate(value: number): number {
  return Math.min(COORDINATE_SCALE, Math.max(0, value));
}

function requiredCacheValue(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`OCR cache ${label} is required`);
  if ([...text].some((character) => character.charCodeAt(0) <= 0x1f)) {
    throw new Error(`OCR cache ${label} contains control characters`);
  }
  return text;
}

function formatBinaryBytes(bytes: number): string {
  return bytes % (1_024 * 1_024) === 0
    ? `${bytes / (1_024 * 1_024)} MiB`
    : `${bytes} bytes`;
}

function parseSha256(value: unknown, label: string): string {
  const sha = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-f0-9]{64}$/.test(sha)) {
    throw new Error(`OCR cache ${label} is invalid`);
  }
  return sha;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error("OCR image crop aborted");
}

export function createDefaultMineruImageFileAccess(): MineruImageFileAccess {
  const io = (globalThis as unknown as { IOUtils?: RuntimeIOUtils }).IOUtils;
  const fileApi = (
    globalThis as unknown as {
      Zotero?: { File?: RuntimeZoteroFile };
    }
  ).Zotero?.File;
  if (!io?.read || !io?.stat || !fileApi?.pathToFile) {
    throw new Error("Zotero file APIs are unavailable for MinerU image OCR");
  }
  return {
    read: (path) => io.read(path),
    stat: (path) => io.stat(path),
    async canonicalize(path) {
      const file = fileApi.pathToFile(path);
      assertPathHasNoSymlink(file);
      file.normalize();
      assertPathHasNoSymlink(file);
      return file.path;
    },
  };
}

function assertPathHasNoSymlink(file: RuntimeFile): void {
  let current: RuntimeFile | null | undefined = file;
  while (current) {
    if (current.isSymlink()) {
      throw new Error(
        `MinerU OCR does not accept symbolic-link paths: ${current.path}`,
      );
    }
    const parent: RuntimeFile | null | undefined = current.parent;
    if (!parent || parent.equals(current)) return;
    current = parent;
  }
}

function getDefaultFileAccess(): MineruImageFileAccess {
  return createDefaultMineruImageFileAccess();
}
