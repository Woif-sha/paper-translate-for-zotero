import assert from "node:assert/strict";
import test from "node:test";
import {
  withPaperContextWriteLock,
  type ValidatedPaperContext,
} from "../src/context/runtime";
import {
  getOcrCacheFileName,
  persistCachedOcrText,
  readCachedOcrText,
} from "../src/ocr/cache";
import { createOcrCacheKey } from "../src/ocr/mineruImages";

const context = {
  identity: {
    parentItemKey: "ABCD1234",
    attachmentKey: "WXYZ5678",
  },
  fullMdSha256: "c".repeat(64),
  paperDir: "E:\\ZoteroData\\paper-translate-for-zotero\\ABCD1234",
} as ValidatedPaperContext;

const keyInput = {
  attachmentKey: "WXYZ5678",
  imageSha256: "a".repeat(64),
  contentListSha256: "b".repeat(64),
  crop: [0.1, 0.2, 0.8, 0.9] as const,
  model: "gpt-5.4",
  effort: "medium",
  promptVersion: "1",
};

test("persists and validates a paper-bound OCR cache entry atomically", async () => {
  const previousIO = (globalThis as any).IOUtils;
  const files = new Map<string, Uint8Array>();
  (globalThis as any).IOUtils = {
    async exists(path: string) {
      return files.has(path);
    },
    async read(path: string) {
      const value = files.get(path);
      if (!value) throw new Error(`missing ${path}`);
      return value;
    },
    async write(path: string, value: Uint8Array, options?: unknown) {
      assert.deepEqual(options, { tmpPath: `${path}.tmp` });
      files.set(path, value);
    },
  };
  try {
    const key = await createOcrCacheKey(keyInput);
    let validations = 0;
    await persistCachedOcrText({
      context,
      key,
      keyInput,
      text: "  line one\nline two  ",
      async assertCurrent() {
        validations += 1;
      },
    });
    assert.equal(validations, 2);
    assert.equal(
      await readCachedOcrText({ context, key }),
      "  line one\nline two  ",
    );
    const stored = new TextDecoder().decode([...files.values()][0]);
    assert.doesNotMatch(stored, /sourcePath|data:image/);
    assert.equal(getOcrCacheFileName(), "ocr-cache.json");
  } finally {
    (globalThis as any).IOUtils = previousIO;
  }
});

test("invalidates a cache bound to an older Markdown revision", async () => {
  const previousIO = (globalThis as any).IOUtils;
  let stored = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      parentItemKey: "ABCD1234",
      fullMdSha256: "d".repeat(64),
      entries: {},
    }),
  );
  (globalThis as any).IOUtils = {
    async exists() {
      return true;
    },
    async read() {
      return stored;
    },
    async write(_path: string, value: Uint8Array) {
      stored = value;
    },
  };
  try {
    assert.equal(
      await readCachedOcrText({ context, key: "a".repeat(64) }),
      undefined,
    );
    const key = await createOcrCacheKey(keyInput);
    await persistCachedOcrText({
      context,
      key,
      keyInput,
      text: "current revision",
      async assertCurrent() {},
    });
    const replaced = JSON.parse(new TextDecoder().decode(stored));
    assert.equal(replaced.fullMdSha256, context.fullMdSha256);
    assert.deepEqual(Object.keys(replaced.entries), [key]);
  } finally {
    (globalThis as any).IOUtils = previousIO;
  }
});

test("rejects a cache bound to another paper", async () => {
  const previousIO = (globalThis as any).IOUtils;
  (globalThis as any).IOUtils = {
    async exists() {
      return true;
    },
    async read() {
      return new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 1,
          parentItemKey: "ZZZZ9999",
          fullMdSha256: context.fullMdSha256,
          entries: {},
        }),
      );
    },
    async write() {
      throw new Error("unexpected write");
    },
  };
  try {
    await assert.rejects(
      () => readCachedOcrText({ context, key: "a".repeat(64) }),
      /does not match the current paper context/,
    );
  } finally {
    (globalThis as any).IOUtils = previousIO;
  }
});

test("serializes the final OCR cache validation and write with paper files", async () => {
  const previousIO = (globalThis as any).IOUtils;
  const files = new Map<string, Uint8Array>();
  let cacheWritten = false;
  (globalThis as any).IOUtils = {
    async exists(path: string) {
      return files.has(path);
    },
    async read(path: string) {
      const value = files.get(path);
      if (!value) throw new Error(`missing ${path}`);
      return value;
    },
    async write(path: string, value: Uint8Array) {
      cacheWritten = true;
      files.set(path, value);
    },
  };
  let releasePaperLock = () => {};
  let confirmPaperLock = () => {};
  const paperLockHeld = new Promise<void>((resolve) => {
    confirmPaperLock = resolve;
  });
  const holdPaperLock = new Promise<void>((resolve) => {
    releasePaperLock = resolve;
  });
  try {
    const holder = withPaperContextWriteLock(context, async () => {
      confirmPaperLock();
      await holdPaperLock;
    });
    await paperLockHeld;
    const key = await createOcrCacheKey(keyInput);
    const persistence = persistCachedOcrText({
      context,
      key,
      keyInput,
      text: "serialized result",
      async assertCurrent() {},
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(cacheWritten, false);
    releasePaperLock();
    await Promise.all([holder, persistence]);
    assert.equal(cacheWritten, true);
  } finally {
    releasePaperLock();
    (globalThis as any).IOUtils = previousIO;
  }
});
