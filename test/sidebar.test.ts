import assert from "node:assert/strict";
import test from "node:test";
import { registerReaderSidebar } from "../src/modules/sidebar";

test("registers a visible Reader pane and binds a parent item to the active attachment", () => {
  let options: any;
  let openedPane = "";
  (globalThis as any).ztoolkit = {
    getGlobal(name: string) {
      assert.equal(name, "Zotero_Tabs");
      return { selectedID: "reader-tab" };
    },
  };
  (globalThis as any).Zotero = {
    ItemPaneManager: {
      registerSection(value: any) {
        options = value;
        return "registered-pane";
      },
    },
    Reader: {
      getByTabID(tabID: string) {
        assert.equal(tabID, "reader-tab");
        return { itemID: 42 };
      },
    },
    Items: {
      get(itemID: number) {
        assert.equal(itemID, 42);
        return { isAttachment: () => true };
      },
    },
    Utilities: {
      Internal: {
        openPreferences(paneID: string) {
          openedPane = paneID;
        },
      },
    },
  };

  registerReaderSidebar();
  assert.equal(options.paneID, "papertranslateforzotero-translation");
  assert.equal(options.pluginID, "papertranslateforzotero@woif-sha.github.io");
  assert.match(options.sidenav.icon, /favicon\.png$/);

  const body = { dataset: {} as Record<string, string> };
  let enabled = false;
  options.onItemChange({
    body,
    item: { id: 7, isAttachment: () => false },
    tabType: "reader",
    setEnabled(value: boolean) {
      enabled = value;
    },
  });
  assert.equal(enabled, true);
  assert.equal(body.dataset.itemId, "42");

  options.sectionButtons[0].onClick();
  assert.equal(openedPane, "papertranslateforzotero-preferences");
});
