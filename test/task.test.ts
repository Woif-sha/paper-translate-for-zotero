import assert from "node:assert/strict";
import test from "node:test";
import {
  addTranslateTask,
  autoDetectLanguage,
  getLastTranslateTask,
} from "../src/utils/task";

test("rejects normalized-empty tasks and keeps identical text isolated by item", () => {
  let sequence = 0;
  const queue: any[] = [];
  (globalThis as any).Zotero = {
    Utilities: { randomString: () => `task-${++sequence}` },
    PaperTranslate: {
      data: {
        translate: { queue, maximumQueueLength: 100 },
      },
    },
  };
  assert.equal(addTranslateTask("\u0001", 1), undefined);
  const first = addTranslateTask("same text", 1)!;
  const second = addTranslateTask("same text", 2)!;
  assert.equal(getLastTranslateTask({ itemId: 1 })?.id, first.id);
  assert.equal(
    getLastTranslateTask({ id: second.id, itemId: 2 })?.id,
    second.id,
  );
  assert.equal(getLastTranslateTask({ id: second.id, itemId: 1 }), undefined);
});

test("uses supported item languages whose catalog only contains a qualified code", () => {
  const previousZotero = (globalThis as any).Zotero;
  const preferences: Record<string, unknown> = {
    sourceLanguage: "en",
    enableAutoDetectLanguage: true,
  };
  (globalThis as any).Zotero = {
    Prefs: {
      get: (key: string) => preferences[key.split(".").at(-1)!],
    },
    Items: { getTopLevel: (items: unknown[]) => items },
    PaperTranslate: {
      data: {
        ztoolkit: { log() {} },
        translate: { cachedSourceLanguage: {} },
      },
    },
  };
  try {
    for (const [language, expected] of [
      ["mni-Mtei", "mni-Mtei"],
      ["nn-NO", "nn-NO"],
      ["NN_no", "nn-NO"],
      ["af-ZA", "af"],
    ]) {
      const item = {
        id: 42,
        getField: (field: string) => (field === "language" ? language : ""),
      } as unknown as Zotero.Item;
      assert.deepEqual(autoDetectLanguage(item), {
        fromLanguage: expected,
        toLanguage: "zh-CN",
        isInferred: true,
      });
    }
  } finally {
    (globalThis as any).Zotero = previousZotero;
  }
});
