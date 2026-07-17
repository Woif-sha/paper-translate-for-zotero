import { config } from "../../package.json";
import {
  ensureCorePaperKnowledge,
  ensureExternalKnowledgeResearch,
} from "../context/research";
import {
  PreparationRecord,
  ValidatedPaperContext,
  createPreparationRecord,
  preparePaperContext,
  readPreparationRecord,
} from "../context/runtime";
import { getLocaleID, getString } from "../utils/locale";
import {
  addTranslateTask,
  getLastTranslateTask,
  TranslateTask,
} from "../utils/task";
import { PREFERENCES_PANE_ID } from "./preferenceWindow";

const activeBodies = new Set<HTMLElement>();
const preparationJobs = new Map<number, Promise<void>>();
const paperContexts = new Map<number, ValidatedPaperContext>();

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
      const attachmentItemID =
        tabType === "reader" ? resolveReaderAttachmentItemID(item) : null;
      body.dataset.itemId = attachmentItemID ? String(attachmentItemID) : "";
      setEnabled(tabType === "reader");
      if (attachmentItemID) ensurePaperPreparation(attachmentItemID);
      return true;
    },
    onRender: ({ body, item, tabType, setEnabled }) => {
      const attachmentItemID =
        tabType === "reader" ? resolveReaderAttachmentItemID(item) : null;
      body.dataset.itemId = attachmentItemID ? String(attachmentItemID) : "";
      setEnabled(tabType === "reader");
      if (tabType !== "reader") return;
      buildSidebar(body);
      if (attachmentItemID) ensurePaperPreparation(attachmentItemID);
      void refreshPreparation(body);
      updateSidebarBody(body);
    },
    sectionButtons: [
      {
        type: `${config.addonRef}-preferences`,
        icon: iconURI("action-settings.svg"),
        l10nID: getLocaleID("sidebar-preferences"),
        onClick: () =>
          Zotero.Utilities.Internal.openPreferences(PREFERENCES_PANE_ID),
      },
    ],
  });
  if (!paneKey)
    throw new Error("Failed to register the Paper Translate Reader sidebar");
}

export function updateReaderSidebar(): void {
  for (const body of activeBodies) {
    void refreshPreparation(body);
    updateSidebarBody(body);
  }
}

function buildSidebar(body: HTMLElement): void {
  if (body.querySelector(`.${config.addonRef}-sidebar`)) return;
  const doc = body.ownerDocument;
  const container = element(doc, "div", `${config.addonRef}-sidebar`);
  Object.assign(container.style, {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "8px",
  });

  const card = element(doc, "section", `${config.addonRef}-paper-card`);
  Object.assign(card.style, {
    padding: "10px",
    border: "1px solid #77ad99",
    borderRadius: "8px",
    background: "#e7f7f1",
  });
  const heading = element(doc, "div", `${config.addonRef}-paper-heading`);
  Object.assign(heading.style, {
    display: "flex",
    alignItems: "flex-start",
    gap: "8px",
  });
  const title = element(doc, "strong", `${config.addonRef}-paper-title`);
  Object.assign(title.style, {
    flex: "1",
    color: "#173b32",
    lineHeight: "1.25",
  });
  const badge = element(doc, "span", `${config.addonRef}-md-badge`);
  badge.textContent = "MD";
  badge.hidden = true;
  Object.assign(badge.style, {
    color: "#168c68",
    background: "#c8f1e2",
    borderRadius: "10px",
    padding: "1px 7px",
    fontSize: "0.85em",
  });
  const meta = element(doc, "div", `${config.addonRef}-paper-meta`);
  Object.assign(meta.style, {
    color: "#6b7f78",
    marginTop: "4px",
    fontSize: "0.9em",
  });
  heading.append(title, badge);
  card.append(heading, meta);

  const preparation = element(doc, "section", `${config.addonRef}-preparation`);
  Object.assign(preparation.style, {
    padding: "8px",
    border: "1px solid var(--fill-quinary)",
    borderRadius: "6px",
  });
  const summary = element(doc, "div", `${config.addonRef}-preparation-summary`);
  Object.assign(summary.style, { fontWeight: "600", marginBottom: "6px" });
  const files = element(doc, "div", `${config.addonRef}-preparation-files`);
  Object.assign(files.style, {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    fontSize: "0.9em",
  });
  preparation.append(summary, files);

  const source = element(doc, "textarea", `${config.addonRef}-sidebar-source`);
  source.rows = 5;
  source.placeholder = getString("sidebar-source-placeholder");
  applyTextareaStyle(source);
  source.addEventListener("input", () => updateSidebarBody(body));
  const translate = element(
    doc,
    "button",
    `${config.addonRef}-sidebar-translate`,
  );
  translate.type = "button";
  translate.textContent = getString("readerpopup-translate-label");
  translate.addEventListener("click", () => {
    const itemId = Number(body.dataset.itemId);
    const input = source.value.trim();
    if (
      !Number.isInteger(itemId) ||
      itemId <= 0 ||
      !input ||
      body.dataset.paperReady !== "true"
    )
      return;
    addTranslateTask(input, itemId);
    updateSidebarBody(body);
    void addon.hooks.onTranslate({
      noCheckZoteroItemLanguage: true,
      noCache: true,
    });
  });
  const result = element(doc, "textarea", `${config.addonRef}-sidebar-result`);
  result.rows = 8;
  result.readOnly = true;
  result.placeholder = getString(getSidebarResultPlaceholderKey());
  applyTextareaStyle(result);
  container.append(card, preparation, source, translate, result);
  body.append(container);
  renderPreparation(body, createPreparationRecord("AAAAAAAA", "pending"));
}

function ensurePaperPreparation(attachmentItemID: number): void {
  if (preparationJobs.has(attachmentItemID)) return;
  const job = preparePaper(attachmentItemID)
    .catch((error) => publishPreparationError(attachmentItemID, error))
    .finally(() => preparationJobs.delete(attachmentItemID));
  preparationJobs.set(attachmentItemID, job);
}

async function preparePaper(attachmentItemID: number): Promise<void> {
  const context = await preparePaperContext(attachmentItemID, "");
  paperContexts.set(attachmentItemID, context);
  await refreshMatchingBodies(attachmentItemID);
  await ensureCorePaperKnowledge(context);
  await refreshMatchingBodies(attachmentItemID);
  await ensureExternalKnowledgeResearch(context);
  await refreshMatchingBodies(attachmentItemID);
}

async function refreshMatchingBodies(itemID: number): Promise<void> {
  for (const body of activeBodies)
    if (Number(body.dataset.itemId) === itemID) await refreshPreparation(body);
}

async function refreshPreparation(body: HTMLElement): Promise<void> {
  const itemID = Number(body.dataset.itemId);
  const context = paperContexts.get(itemID);
  if (!context) return;
  renderPaperCard(body, context);
  renderPreparation(body, await readPreparationRecord(context));
  updateSidebarBody(body);
}

function renderPaperCard(
  body: HTMLElement,
  context: ValidatedPaperContext,
): void {
  const title = body.querySelector(`.${config.addonRef}-paper-title`);
  const meta = body.querySelector(`.${config.addonRef}-paper-meta`);
  const badge = body.querySelector(
    `.${config.addonRef}-md-badge`,
  ) as HTMLElement | null;
  if (title)
    title.textContent =
      context.identity.title || getString("sidebar-untitled-paper");
  const parent =
    Zotero.Items.getByLibraryAndKey(
      context.identity.libraryID,
      context.identity.parentItemKey,
    ) || null;
  const creators = parent?.getCreators?.() ?? [];
  const names = creators
    .map(
      (creator: { lastName?: string; name?: string }) =>
        creator.lastName || creator.name,
    )
    .filter(Boolean)
    .slice(0, 3);
  const year = String(parent?.getField("date") || "").match(/\d{4}/)?.[0] || "";
  if (meta)
    meta.textContent = [names.join(", "), year].filter(Boolean).join(" · ");
  if (badge) badge.hidden = false;
}

export function formatPreparationRows(
  record: PreparationRecord,
): Array<{ text: string; status: string }> {
  const labels: Record<string, string> = {
    source: "正文身份",
    index: "章节索引",
    background: "论文背景",
    terminology: "双语术语",
    external: "外部补充",
  };
  return record.stages.map((stage) => ({
    status: stage.status,
    text: `${labels[stage.id]}：${stage.file}${stage.id === "external" && stage.status === "warning" ? `（完成，${stage.detail || "有来源受限"}）` : ""}`,
  }));
}

function renderPreparation(body: HTMLElement, record: PreparationRecord): void {
  const summary = body.querySelector(`.${config.addonRef}-preparation-summary`);
  const files = body.querySelector(`.${config.addonRef}-preparation-files`);
  if (!summary || !files) return;
  const completed = record.stages.filter((stage) =>
    ["complete", "warning", "skipped"].includes(stage.status),
  ).length;
  summary.textContent = `${getString("sidebar-preparation-title")} ${completed}/${record.stages.length}`;
  files.replaceChildren(
    ...formatPreparationRows(record).map((row) => {
      const line = element(
        body.ownerDocument,
        "div",
        `${config.addonRef}-preparation-row`,
      );
      line.dataset.status = row.status;
      line.textContent = `${stageIcon(row.status)} ${row.text}`;
      return line;
    }),
  );
  body.dataset.paperReady = String(
    record.overall === "core-ready" || record.overall === "ready",
  );
}

function publishPreparationError(itemID: number, error: unknown): void {
  for (const body of activeBodies) {
    if (Number(body.dataset.itemId) !== itemID) continue;
    const summary = body.querySelector(
      `.${config.addonRef}-preparation-summary`,
    );
    if (summary)
      summary.textContent = `${getString("sidebar-preparation-error")}: ${conciseError(error)}`;
    body.dataset.paperReady = "false";
    updateSidebarBody(body);
  }
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
    translate.disabled = !paperReady || !source.value.trim();
    return;
  }
  if (source.ownerDocument.activeElement !== source) source.value = task.raw;
  result.value = task.result;
  if (task.status === "processing")
    result.placeholder = getString(getSidebarResultPlaceholderKey(task.status));
  translate.disabled = !paperReady || task.status === "processing";
}

export function getSidebarResultPlaceholderKey(
  status?: TranslateTask["status"],
): "sidebar-result-placeholder" | "status-translating" {
  return status === "processing"
    ? "status-translating"
    : "sidebar-result-placeholder";
}

function resolveReaderAttachmentItemID(item: Zotero.Item): number | null {
  if (item.isAttachment()) return item.id;
  const tabs = ztoolkit.getGlobal("Zotero_Tabs") as { selectedID?: string };
  const reader = tabs.selectedID
    ? Zotero.Reader.getByTabID(tabs.selectedID)
    : null;
  const itemID = Number(reader?.itemID);
  if (!Number.isInteger(itemID) || itemID <= 0) return null;
  return Zotero.Items.get(itemID)?.isAttachment() ? itemID : null;
}

function stageIcon(status: string): string {
  if (status === "running") return "◌";
  if (status === "complete") return "✓";
  if (status === "warning") return "⚠";
  if (status === "error") return "✕";
  if (status === "skipped") return "–";
  return "○";
}

function conciseError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/\S+/g, "[URL omitted]")
    .slice(0, 180);
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

function element<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const result = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    tag,
  ) as HTMLElementTagNameMap[K];
  result.className = className;
  return result;
}
