import {
  withPaperContextWriteLock,
  type ValidatedPaperContext,
} from "../context/runtime";
import {
  createOcrCacheKey,
  type OcrCacheKeyInput,
  type RelativeCropBox,
} from "./mineruImages";

const OCR_CACHE_FILE_NAME = "ocr-cache.json";
const OCR_CACHE_SCHEMA_VERSION = 1;
const MAXIMUM_CACHE_ENTRIES = 128;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const cacheWrites = new Map<string, Promise<void>>();

type OcrCacheEntry = {
  text: string;
  attachmentKey: string;
  imageSha256: string;
  contentListSha256: string;
  crop: RelativeCropBox;
  model: string;
  effort: string;
  promptVersion: string;
  createdAt: string;
};

type OcrCacheRecord = {
  schemaVersion: typeof OCR_CACHE_SCHEMA_VERSION;
  parentItemKey: string;
  fullMdSha256: string;
  entries: Record<string, OcrCacheEntry>;
};

type IOUtilsLike = {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<Uint8Array | ArrayBuffer>;
  write(
    path: string,
    data: Uint8Array,
    options?: { tmpPath?: string },
  ): Promise<unknown>;
};

export async function readCachedOcrText(params: {
  context: ValidatedPaperContext;
  key: string;
}): Promise<string | undefined> {
  const io = getIOUtils();
  const path = cachePath(params.context);
  if (!(await io.exists(path))) return undefined;
  const record = await readAndValidateCache(io, path, params.context);
  const entry = record?.entries[params.key];
  return entry?.text;
}

export async function persistCachedOcrText(params: {
  context: ValidatedPaperContext;
  key: string;
  keyInput: OcrCacheKeyInput;
  text: string;
  assertCurrent(): Promise<void>;
}): Promise<void> {
  const path = cachePath(params.context);
  await withCacheWriteLock(path, async () => {
    await params.assertCurrent();
    const expectedKey = await createOcrCacheKey(params.keyInput);
    if (params.key !== expectedKey) {
      throw new Error("OCR cache key does not match its image selection");
    }
    const text = params.text;
    if (!text.trim()) throw new Error("OCR cache cannot store empty text");
    const io = getIOUtils();
    const record = (await io.exists(path))
      ? await readAndValidateCache(io, path, params.context)
      : createEmptyCache(params.context);
    const currentRecord = record ?? createEmptyCache(params.context);
    const entries = {
      ...currentRecord.entries,
      [params.key]: {
        text,
        attachmentKey: params.keyInput.attachmentKey.trim(),
        imageSha256: params.keyInput.imageSha256.toLowerCase(),
        contentListSha256: params.keyInput.contentListSha256.toLowerCase(),
        crop: [...params.keyInput.crop] as RelativeCropBox,
        model: params.keyInput.model.trim(),
        effort: normalizeEffort(params.keyInput.effort),
        promptVersion: params.keyInput.promptVersion.trim(),
        createdAt: new Date().toISOString(),
      },
    };
    const trimmedEntries = Object.fromEntries(
      Object.entries(entries)
        .sort(
          ([, left], [, right]) =>
            Date.parse(right.createdAt) - Date.parse(left.createdAt),
        )
        .slice(0, MAXIMUM_CACHE_ENTRIES),
    );
    await withPaperContextWriteLock(params.context, async () => {
      await params.assertCurrent();
      await io.write(
        path,
        encoder.encode(
          `${JSON.stringify(
            { ...currentRecord, entries: trimmedEntries },
            null,
            2,
          )}\n`,
        ),
        { tmpPath: `${path}.tmp` },
      );
    });
  });
}

export function getOcrCacheFileName(): string {
  return OCR_CACHE_FILE_NAME;
}

function createEmptyCache(context: ValidatedPaperContext): OcrCacheRecord {
  return {
    schemaVersion: OCR_CACHE_SCHEMA_VERSION,
    parentItemKey: context.identity.parentItemKey,
    fullMdSha256: context.fullMdSha256,
    entries: {},
  };
}

async function readAndValidateCache(
  io: IOUtilsLike,
  path: string,
  context: ValidatedPaperContext,
): Promise<OcrCacheRecord | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(asBytes(await io.read(path))));
  } catch (error) {
    throw new Error(`OCR cache is invalid: ${String(error)}`);
  }
  if (!isObject(parsed)) throw new Error("OCR cache must be a JSON object");
  if (
    parsed.schemaVersion !== OCR_CACHE_SCHEMA_VERSION ||
    parsed.parentItemKey !== context.identity.parentItemKey ||
    !isObject(parsed.entries)
  ) {
    throw new Error("OCR cache does not match the current paper context");
  }
  if (parsed.fullMdSha256 !== context.fullMdSha256) {
    if (
      typeof parsed.fullMdSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(parsed.fullMdSha256)
    ) {
      throw new Error("OCR cache has an invalid Markdown identity");
    }
    return null;
  }
  const entries: Record<string, OcrCacheEntry> = {};
  for (const [key, value] of Object.entries(parsed.entries)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !isObject(value)) {
      throw new Error("OCR cache contains an invalid entry");
    }
    const entry = validateEntry(value);
    const expectedKey = await createOcrCacheKey({
      attachmentKey: entry.attachmentKey,
      imageSha256: entry.imageSha256,
      contentListSha256: entry.contentListSha256,
      crop: entry.crop,
      model: entry.model,
      effort: entry.effort,
      promptVersion: entry.promptVersion,
    });
    if (expectedKey !== key) {
      throw new Error("OCR cache entry key does not match its metadata");
    }
    entries[key] = entry;
  }
  return {
    schemaVersion: OCR_CACHE_SCHEMA_VERSION,
    parentItemKey: parsed.parentItemKey,
    fullMdSha256: parsed.fullMdSha256,
    entries,
  };
}

function validateEntry(value: Record<string, unknown>): OcrCacheEntry {
  const text = requiredOcrText(value.text);
  const attachmentKey = requiredString(value.attachmentKey, "attachmentKey");
  const imageSha256 = requiredSha256(value.imageSha256, "imageSha256");
  const contentListSha256 = requiredSha256(
    value.contentListSha256,
    "contentListSha256",
  );
  const crop = validateCrop(value.crop);
  const model = requiredString(value.model, "model");
  const effort = normalizeEffort(value.effort);
  const promptVersion = requiredString(value.promptVersion, "promptVersion");
  const createdAt = requiredString(value.createdAt, "createdAt");
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error("OCR cache entry createdAt is invalid");
  }
  return {
    text,
    attachmentKey,
    imageSha256,
    contentListSha256,
    crop,
    model,
    effort,
    promptVersion,
    createdAt,
  };
}

function requiredOcrText(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    containsDisallowedControlCharacter(value)
  ) {
    throw new Error("OCR cache entry text is invalid");
  }
  return value;
}

function validateCrop(value: unknown): RelativeCropBox {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value.some(
      (coordinate) =>
        typeof coordinate !== "number" ||
        !Number.isFinite(coordinate) ||
        coordinate < 0 ||
        coordinate > 1,
    ) ||
    value[0] >= value[2] ||
    value[1] >= value[3]
  ) {
    throw new Error("OCR cache entry crop is invalid");
  }
  return [value[0], value[1], value[2], value[3]];
}

function requiredString(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || containsDisallowedControlCharacter(text)) {
    throw new Error(`OCR cache entry ${field} is invalid`);
  }
  return text;
}

function containsDisallowedControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f)
    );
  });
}

function requiredSha256(value: unknown, field: string): string {
  const text = requiredString(value, field).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw new Error(`OCR cache entry ${field} is invalid`);
  }
  return text;
}

function normalizeEffort(value: unknown): string {
  return (
    (typeof value === "string" ? value.trim().toLowerCase() : "") || "auto"
  );
}

function cachePath(context: ValidatedPaperContext): string {
  const separator = context.paperDir.includes("\\") ? "\\" : "/";
  return `${context.paperDir.replace(/[\\/]+$/u, "")}${separator}${OCR_CACHE_FILE_NAME}`;
}

function getIOUtils(): IOUtilsLike {
  const io = (globalThis as unknown as { IOUtils?: IOUtilsLike }).IOUtils;
  if (!io?.exists || !io?.read || !io?.write) {
    throw new Error("IOUtils is unavailable for the OCR cache");
  }
  return io;
}

function asBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function withCacheWriteLock(
  path: string,
  operation: () => Promise<void>,
): Promise<void> {
  const previous = cacheWrites.get(path) || Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  cacheWrites.set(path, current);
  try {
    await current;
  } finally {
    if (cacheWrites.get(path) === current) cacheWrites.delete(path);
  }
}
