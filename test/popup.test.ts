import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { updatePopupSourceTask } from "../src/modules/popup";
import { addTranslateTask } from "../src/utils/task";

test("resizes source and translation together through one shared panel", async () => {
  const source = await readFile(
    new URL("../src/modules/popup.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /width: "320px"/);
  assert.match(
    source,
    /gridTemplateRows: "minmax\(48px, 1fr\) auto minmax\(48px, 1fr\)"/,
  );
  assert.match(source, /resize: "both"/);
  assert.match(source, /width: "100%"/);
  assert.match(source, /height: "100%"/);
  assert.match(source, /resize: "none"/);
  assert.doesNotMatch(source, /maxWidth: "320px"|maxHeight: "96px"/);
  assert.match(source, /getPopupTask\(popup, itemId\)/);
  assert.match(source, /papertranslateforzotero.*task-id|addonRef}-task-id/);
});

test("editing a streaming source creates a separate task", () => {
  let sequence = 0;
  const queue: any[] = [];
  (globalThis as any).Zotero = {
    Utilities: { randomString: () => `task-${++sequence}` },
    PaperTranslate: {
      data: { translate: { queue, maximumQueueLength: 100 } },
    },
  };
  const attributes = new Map<string, string>();
  const popup = {
    getAttribute(name: string) {
      return attributes.get(name) ?? null;
    },
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    removeAttribute(name: string) {
      attributes.delete(name);
    },
  } as unknown as Element;
  const current = addTranslateTask("old source", 42)!;
  current.status = "processing";
  attributes.set("papertranslateforzotero-task-id", current.id);

  const replacement = updatePopupSourceTask(popup, 42, "new source")!;

  assert.notEqual(replacement.id, current.id);
  assert.equal(current.raw, "old source");
  assert.equal(replacement.raw, "new source");
  assert.equal(replacement.status, "waiting");
  assert.equal(
    attributes.get("papertranslateforzotero-task-id"),
    replacement.id,
  );
});
