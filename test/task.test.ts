import assert from "node:assert/strict";
import test from "node:test";
import { addTranslateTask, getLastTranslateTask } from "../src/utils/task";

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
