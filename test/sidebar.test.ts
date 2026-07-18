import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  formatPreparationRows,
  getSidebarResultPlaceholderKey,
  isTranslationReady,
  openPaperContextDirectory,
  preparationRefreshIsCurrent,
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

test("rejects late preparation reads after progress or paper changes", () => {
  const baseline = {
    expectedVersion: 3,
    currentVersion: 3,
    expectedItemID: 42,
    currentItemID: 42,
    expectedFullMdSha256: "hash-a",
    currentFullMdSha256: "hash-a",
  };
  assert.equal(preparationRefreshIsCurrent(baseline), true);
  assert.equal(
    preparationRefreshIsCurrent({ ...baseline, currentVersion: 4 }),
    false,
  );
  assert.equal(
    preparationRefreshIsCurrent({ ...baseline, currentItemID: 43 }),
    false,
  );
  assert.equal(
    preparationRefreshIsCurrent({
      ...baseline,
      currentFullMdSha256: "hash-b",
    }),
    false,
  );
});

test("renders file progress without background text or full error URLs", () => {
  const previousAddon = (globalThis as any).addon;
  const messages: Record<string, string> = {
    "papertranslateforzotero-sidebar-stage-source": "正文身份",
    "papertranslateforzotero-sidebar-stage-background": "论文背景",
    "papertranslateforzotero-sidebar-stage-external": "外部补充",
    "papertranslateforzotero-sidebar-stage-row": "{label}：{file}{suffix}",
    "papertranslateforzotero-sidebar-stage-warning": "（完成，{detail}）",
    "papertranslateforzotero-sidebar-stage-warning-default": "有来源受限",
    "papertranslateforzotero-sidebar-stage-error": "（错误：{detail}）",
    "papertranslateforzotero-sidebar-stage-error-default": "文件无效",
  };
  (globalThis as any).addon = {
    data: {
      locale: {
        current: {
          formatMessagesSync([{ id, args }]: any[]) {
            const value = (messages[id] || id).replace(
              /\{(\w+)\}/g,
              (_match, key) => String(args?.[key] || ""),
            );
            return [{ value }];
          },
        },
      },
    },
  };
  try {
    const rows = formatPreparationRows({
      stages: [
        {
          id: "source",
          file: "_paper_source.json",
          required: true,
          status: "complete",
        },
        {
          id: "background",
          file: "background.md",
          required: false,
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
      integrityIssues: [
        {
          stage: "background",
          detail: "完成记录与文件不一致",
          detectedAt: "2026-07-18T00:00:00.000Z",
        },
      ],
    } as any);
    assert.deepEqual(rows, [
      { status: "complete", text: "正文身份：_paper_source.json" },
      {
        status: "error",
        text: "论文背景：background.md（错误：完成记录与文件不一致）",
      },
      {
        status: "warning",
        text: "外部补充：background-sources.json（完成，1 个来源受限）",
      },
    ]);
    assert.doesNotMatch(
      rows.map((row) => row.text).join(" "),
      /https:|HTTP GET/,
    );
  } finally {
    (globalThis as any).addon = previousAddon;
  }
});

test("opens only the validated current paper directory", () => {
  let opened = "";
  (globalThis as any).Zotero = {
    launchFile(path: string) {
      opened = path;
    },
  };
  openPaperContextDirectory({
    paperDir: "E:\\ZoteroData\\paper-translate-for-zotero\\ABCD1234",
  });
  assert.equal(opened, "E:\\ZoteroData\\paper-translate-for-zotero\\ABCD1234");
});

test("keeps the directory button available after a progress read error", async () => {
  const source = await readFile(
    new URL("../src/modules/sidebar.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /openDirectory\.disabled = !paperContexts\.has\(itemID\)/,
  );
});

test("registers a visible Reader pane and binds a parent item to the active attachment", async () => {
  let options: any;
  let openedPane = "";
  (globalThis as any).ztoolkit = {
    getGlobal(name: string) {
      assert.equal(name, "Zotero_Tabs");
      return { selectedID: "reader-tab" };
    },
  };
  (globalThis as any).Zotero = {
    logError() {},
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

  const body = {
    dataset: {} as Record<string, string>,
    querySelector: () => null,
  };
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
  await new Promise<void>((resolve) => setImmediate(resolve));

  options.sectionButtons[0].onClick();
  assert.equal(openedPane, "papertranslateforzotero-preferences");
});
