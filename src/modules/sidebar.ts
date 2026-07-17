import { config } from "../../package.json";
import { ensureBackgroundResearch } from "../context/research";
import {
  preparePaperContext,
  readBackgroundResearchRecord,
} from "../context/runtime";
import { getLocaleID, getString } from "../utils/locale";
import {
  addTranslateTask,
  getLastTranslateTask,
  TranslateTask,
} from "../utils/task";
import { PREFERENCES_PANE_ID } from "./preferenceWindow";

type PaperPreparationState = {
  markdown: "checking" | "ready" | "error";
  background: "waiting" | "researching" | "ready" | "empty" | "error";
  detail: string;
};

const activeBodies = new Set<HTMLElement>();
const preparationJobs = new Map<number, Promise<void>>();
const preparationStates = new Map<number, PaperPreparationState>();

export function registerReaderSidebar(): void {
  const paneKey = Zotero.ItemPaneManager.registerSection({
    paneID: `${config.addonRef}-translation`,
    pluginID: config.addonID,
    header: {
      l10nID: getLocaleID("sidebar-title"),
      icon: iconURI("section-16.png"),
    },
    sidenav: {
      l10nID: getLocaleID("sidebar-tooltip"),
      icon: iconURI("section-20.png"),
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
      if (attachmentItemID) ensurePaperPreparation(attachmentItemID);
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
      if (attachmentItemID) ensurePaperPreparation(attachmentItemID);
      renderPreparationState(body);
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
  for (const body of activeBodies) {
    renderPreparationState(body);
    updateSidebarBody(body);
  }
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

  const status = createHTMLElement(doc, "section");
  status.className = `${config.addonRef}-sidebar-status`;
  Object.assign(status.style, {
    display: "flex",
    flexDirection: "column",
    gap: "5px",
    padding: "8px",
    border: "1px solid var(--fill-quinary)",
    borderRadius: "6px",
    background: "var(--material-background)",
  });
  const markdownStatus = createHTMLElement(doc, "div");
  markdownStatus.className = `${config.addonRef}-sidebar-md-status`;
  const backgroundStatus = createHTMLElement(doc, "div");
  backgroundStatus.className = `${config.addonRef}-sidebar-background-status`;
  const statusDetail = createHTMLElement(doc, "div");
  statusDetail.className = `${config.addonRef}-sidebar-status-detail`;
  Object.assign(statusDetail.style, {
    color: "var(--fill-secondary)",
    fontSize: "0.9em",
    lineHeight: "1.4",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  });
  status.append(markdownStatus, backgroundStatus, statusDetail);

  const source = createHTMLElement(doc, "textarea");
  source.className = `${config.addonRef}-sidebar-source`;
  source.rows = 5;
  source.placeholder = getString("sidebar-source-placeholder");
  applyTextareaStyle(source);

  const translate = createHTMLElement(doc, "button");
  translate.className = `${config.addonRef}-sidebar-translate`;
  translate.type = "button";
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
  result.placeholder = getString(getSidebarResultPlaceholderKey());
  applyTextareaStyle(result);

  container.append(status, source, translate, result);
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
  result.placeholder = getString(getSidebarResultPlaceholderKey());
  if (!Number.isInteger(itemId) || itemId <= 0) {
    result.value = getString("sidebar-no-attachment");
    translate.disabled = true;
    return;
  }
  const task = getLastTranslateTask({ itemId });
  const paperReady = body.dataset.paperReady === "true";
  if (!task) {
    result.value = "";
    translate.disabled = !paperReady;
    return;
  }
  if (source.ownerDocument.activeElement !== source) source.value = task.raw;
  result.value = task.result;
  if (task.status === "processing") {
    result.placeholder = getString(getSidebarResultPlaceholderKey(task.status));
  }
  translate.disabled = !paperReady || task.status === "processing";
}

export function getSidebarResultPlaceholderKey(
  status?: TranslateTask["status"],
): "sidebar-result-placeholder" | "status-translating" {
  return status === "processing"
    ? "status-translating"
    : "sidebar-result-placeholder";
}

function ensurePaperPreparation(attachmentItemID: number): void {
  if (preparationJobs.has(attachmentItemID)) return;
  const existing = preparationStates.get(attachmentItemID);
  if (
    existing?.markdown === "ready" &&
    (existing.background === "ready" || existing.background === "empty")
  ) {
    return;
  }
  publishPreparationState(attachmentItemID, {
    markdown: "checking",
    background: "waiting",
    detail: "",
  });
  const job = preparePaper(attachmentItemID)
    .catch((error) => {
      const current = preparationStates.get(attachmentItemID);
      publishPreparationState(attachmentItemID, {
        markdown: current?.markdown === "ready" ? "ready" : "error",
        background: current?.markdown === "ready" ? "error" : "waiting",
        detail: String(error),
      });
    })
    .finally(() => preparationJobs.delete(attachmentItemID));
  preparationJobs.set(attachmentItemID, job);
}

async function preparePaper(attachmentItemID: number): Promise<void> {
  const context = await preparePaperContext(attachmentItemID, "");
  publishPreparationState(attachmentItemID, {
    markdown: "ready",
    background: "waiting",
    detail: context.fullMdPath,
  });
  let record = await readBackgroundResearchRecord(context);
  if (record.status === "pending") {
    publishPreparationState(attachmentItemID, {
      markdown: "ready",
      background: "researching",
      detail: context.fullMdPath,
    });
    await ensureBackgroundResearch(context);
    record = await readBackgroundResearchRecord(context);
  }
  const background = formatBackgroundPreview(context.background);
  const failures = (record.failures ?? [])
    .map((failure) => `${failure.provider}: ${failure.message}`)
    .join("\n");
  publishPreparationState(attachmentItemID, {
    markdown: "ready",
    background: record.status === "empty" ? "empty" : "ready",
    detail: [background, failures].filter(Boolean).join("\n\n"),
  });
}

function publishPreparationState(
  attachmentItemID: number,
  state: PaperPreparationState,
): void {
  preparationStates.set(attachmentItemID, state);
  for (const body of activeBodies) {
    if (Number(body.dataset.itemId) === attachmentItemID) {
      renderPreparationState(body);
      updateSidebarBody(body);
    }
  }
}

function renderPreparationState(body: HTMLElement): void {
  const markdown = body.querySelector(
    `.${config.addonRef}-sidebar-md-status`,
  ) as HTMLElement | null;
  const background = body.querySelector(
    `.${config.addonRef}-sidebar-background-status`,
  ) as HTMLElement | null;
  const detail = body.querySelector(
    `.${config.addonRef}-sidebar-status-detail`,
  ) as HTMLElement | null;
  if (!markdown || !background || !detail) return;
  const itemID = Number(body.dataset.itemId);
  const state = preparationStates.get(itemID) ?? {
    markdown: "checking",
    background: "waiting",
    detail: "",
  };
  body.dataset.paperReady = String(state.markdown === "ready");
  markdown.textContent = getString(`sidebar-md-${state.markdown}`);
  background.textContent = getString(`sidebar-background-${state.background}`);
  detail.textContent = state.detail;
  detail.hidden = !state.detail;
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

function formatBackgroundPreview(value: string): string {
  return value
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n")
    .trim()
    .slice(0, 800);
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
