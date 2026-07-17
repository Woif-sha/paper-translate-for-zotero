import assert from "node:assert/strict";
import test from "node:test";
import {
  formatPreparationRows,
  getSidebarResultPlaceholderKey,
  isTranslationReady,
  registerReaderSidebar,
} from "../src/modules/sidebar";

test("does not claim to translate before a task starts", () => {
  assert.equal(getSidebarResultPlaceholderKey(), "sidebar-result-placeholder");
  assert.equal(
    getSidebarResultPlaceholderKey("processing"),
    "status-translating",
  );
});

test("allows translation as soon as source and index files are complete", () => {
  assert.equal(
    isTranslationReady({
      stages: [
        { id: "source", status: "complete" },
        { id: "index", status: "complete" },
        { id: "background", status: "running" },
        { id: "terminology", status: "pending" },
        { id: "external", status: "pending" },
      ],
    } as any),
    true,
  );
});

test("keeps translation ready when background preparation reports an error", () => {
  assert.equal(
    isTranslationReady({
      stages: [
        { id: "source", status: "complete" },
        { id: "index", status: "complete" },
        { id: "background", status: "error" },
        { id: "terminology", status: "error" },
        { id: "external", status: "pending" },
      ],
    } as any),
    true,
  );
});

test("renders file progress without background text or full error URLs", () => {
  const rows = formatPreparationRows({
    stages: [
      {
        id: "source",
        file: "_paper_source.json",
        required: true,
        status: "complete",
      },
      {
        id: "external",
        file: "background-sources.json",
        required: false,
        status: "warning",
        detail: "1 个来源受限",
      },
    ],
  } as any);
  assert.deepEqual(rows, [
    { status: "complete", text: "正文身份：_paper_source.json" },
    {
      status: "warning",
      text: "外部补充：background-sources.json（完成，1 个来源受限）",
    },
  ]);
  assert.doesNotMatch(rows.map((row) => row.text).join(" "), /https:|HTTP GET/);
});

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
  assert.match(options.header.icon, /section-16\.png$/);
  assert.match(options.sidenav.icon, /section-20\.png$/);

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
