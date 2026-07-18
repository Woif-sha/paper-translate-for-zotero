import assert from "node:assert/strict";
import test from "node:test";
import api from "../src/api";

test("an older task cannot invalidate the active task refresh handler", () => {
  const previousAddon = (globalThis as any).addon;
  const previousZotero = (globalThis as any).Zotero;
  const first = { id: "first", itemId: 42 } as any;
  const second = { id: "second", itemId: 42 } as any;
  const plugin = { data: { translate: { queue: [first, second] } } };
  let refreshes = 0;
  (globalThis as any).Zotero = { PaperTranslate: plugin };
  (globalThis as any).addon = {
    ...plugin,
    hooks: {
      onReaderPopupRefresh() {
        refreshes += 1;
      },
    },
  };
  try {
    const staleRefresh = api.getTemporaryRefreshHandler({ task: first });
    const activeRefresh = api.getTemporaryRefreshHandler({ task: second });
    staleRefresh();
    assert.equal(refreshes, 0);
    activeRefresh();
    assert.equal(refreshes, 1);
    staleRefresh();
    activeRefresh();
    assert.equal(refreshes, 2);
  } finally {
    (globalThis as any).addon = previousAddon;
    (globalThis as any).Zotero = previousZotero;
  }
});
