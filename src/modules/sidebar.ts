import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import { addTranslateTask, getLastTranslateTask } from "../utils/task";
import { PREFERENCES_PANE_ID } from "./preferenceWindow";

const activeBodies = new Set<HTMLElement>();

export function registerReaderSidebar(): void {
  const paneKey = Zotero.ItemPaneManager.registerSection({
    paneID: `${config.addonRef}-translation`,
    pluginID: config.addonID,
    header: {
      l10nID: getLocaleID("sidebar-title"),
      icon: iconURI("favicon.png"),
    },
    sidenav: {
      l10nID: getLocaleID("sidebar-tooltip"),
      icon: iconURI("favicon.png"),
    },
    onInit: ({ body }) => activeBodies.add(body),
    onDestroy: ({ body }) => activeBodies.delete(body),
    onItemChange: ({ body, item, tabType, setEnabled }) => {
      const enabled = tabType === "reader";
      const attachmentItemID = enabled
        ? resolveReaderAttachmentItemID(item)
        : null;
      body.dataset.itemId = attachmentItemID ? String(attachmentItemID) : "";
      setEnabled(enabled);
      return true;
    },
    onRender: ({ body, item, tabType, setEnabled }) => {
      const enabled = tabType === "reader";
      const attachmentItemID = enabled
        ? resolveReaderAttachmentItemID(item)
        : null;
      body.dataset.itemId = attachmentItemID ? String(attachmentItemID) : "";
      setEnabled(enabled);
      if (!enabled) return;
      buildSidebar(body);
      updateSidebarBody(body);
    },
    sectionButtons: [
      {
        type: `${config.addonRef}-preferences`,
        icon: iconURI("action-settings.svg"),
        l10nID: getLocaleID("sidebar-preferences"),
        onClick: () => {
          Zotero.Utilities.Internal.openPreferences(PREFERENCES_PANE_ID);
        },
      },
    ],
  });
  if (!paneKey) {
    throw new Error("Failed to register the Paper Translate Reader sidebar");
  }
}

export function updateReaderSidebar(): void {
  for (const body of activeBodies) updateSidebarBody(body);
}

function buildSidebar(body: HTMLElement): void {
  if (body.querySelector(`.${config.addonRef}-sidebar`)) return;
  const doc = body.ownerDocument;
  const container = createHTMLElement(doc, "div");
  container.className = `${config.addonRef}-sidebar`;
  Object.assign(container.style, {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "8px",
  });

  const source = createHTMLElement(doc, "textarea");
  source.className = `${config.addonRef}-sidebar-source`;
  source.rows = 5;
  source.placeholder = getString("sidebar-source-placeholder");
  applyTextareaStyle(source);

  const translate = createHTMLElement(doc, "button");
  translate.className = `${config.addonRef}-sidebar-translate`;
  translate.textContent = getString("readerpopup-translate-label");
  translate.addEventListener("click", () => {
    const itemId = Number(body.dataset.itemId);
    const input = source.value.trim();
    if (!Number.isInteger(itemId) || itemId <= 0 || !input) return;
    addTranslateTask(input, itemId);
    updateSidebarBody(body);
    void addon.hooks.onTranslate({
      noCheckZoteroItemLanguage: true,
      noCache: true,
    });
  });

  const result = createHTMLElement(doc, "textarea");
  result.className = `${config.addonRef}-sidebar-result`;
  result.rows = 8;
  result.readOnly = true;
  result.placeholder = getString("status-translating");
  applyTextareaStyle(result);

  container.append(source, translate, result);
  body.append(container);
}

function updateSidebarBody(body: HTMLElement): void {
  const itemId = Number(body.dataset.itemId);
  const source = body.querySelector(
    `.${config.addonRef}-sidebar-source`,
  ) as HTMLTextAreaElement | null;
  const result = body.querySelector(
    `.${config.addonRef}-sidebar-result`,
  ) as HTMLTextAreaElement | null;
  const translate = body.querySelector(
    `.${config.addonRef}-sidebar-translate`,
  ) as HTMLButtonElement | null;
  if (!source || !result || !translate) return;
  if (!Number.isInteger(itemId) || itemId <= 0) {
    result.value = getString("sidebar-no-attachment");
    translate.disabled = true;
    return;
  }
  const task = getLastTranslateTask({ itemId });
  if (!task) return;
  if (source.ownerDocument.activeElement !== source) source.value = task.raw;
  result.value = task.result;
  translate.disabled = task.status === "processing";
}

function resolveReaderAttachmentItemID(item: Zotero.Item): number | null {
  if (item.isAttachment()) return item.id;
  const tabs = ztoolkit.getGlobal("Zotero_Tabs") as {
    selectedID?: string;
  };
  const reader = tabs.selectedID
    ? Zotero.Reader.getByTabID(tabs.selectedID)
    : null;
  const itemID = Number(reader?.itemID);
  if (!Number.isInteger(itemID) || itemID <= 0) return null;
  const attachment = Zotero.Items.get(itemID);
  return attachment?.isAttachment() ? itemID : null;
}

function applyTextareaStyle(textarea: HTMLTextAreaElement): void {
  Object.assign(textarea.style, {
    boxSizing: "border-box",
    width: "100%",
    resize: "vertical",
    border: "1px solid var(--fill-quinary)",
    borderRadius: "6px",
    padding: "8px",
    color: "var(--fill-primary)",
    background: "var(--material-background)",
    font: "inherit",
  });
}

function iconURI(name: string): string {
  return `chrome://${config.addonRef}/content/icons/${name}`;
}

function createHTMLElement<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tagName: K,
): HTMLElementTagNameMap[K] {
  return doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    tagName,
  ) as HTMLElementTagNameMap[K];
}
