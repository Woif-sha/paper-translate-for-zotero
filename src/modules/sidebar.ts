import { config } from "../../package.json";
import { continuePaperLearning } from "../context/research";
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
  dispatchTranslateTask,
  getLastTranslateTask,
  normalizeTaskText,
  TranslateTask,
} from "../utils/task";
import { PREFERENCES_PANE_ID } from "./preferenceWindow";
import { cancelActiveTranslation } from "../backends/translator";
import { FluentMessageId } from "../../typings/i10n";

const activeBodies = new Set<HTMLElement>();
const preparationJobs = new Map<number, Promise<void>>();
const preparationAttempts = new Set<number>();
type ContextErrorRecord = { fullMdSha256?: string; error: Error };
const preparationErrors = new Map<number, ContextErrorRecord>();
const learningErrors = new Map<number, ContextErrorRecord>();
const learningMonitors = new Map<string, Promise<void>>();
const paperContexts = new Map<number, ValidatedPaperContext>();
const preparationRefreshVersions = new WeakMap<HTMLElement, number>();
let registeredPaneKey: string | null = null;

export function registerReaderSidebar(): void {
  if (registeredPaneKey) return;
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
    onDestroy: ({ body }) => {
      const itemID = Number(body.dataset.itemId);
      activeBodies.delete(body);
      invalidatePreparationRefresh(body);
      if (!hasActiveBodyForItem(itemID)) cancelActiveTranslation(itemID);
      releaseUnusedPaperContext(itemID);
    },
    onItemChange: ({ body, item, tabType, setEnabled }) => {
      const attachmentItemID =
        tabType === "reader" ? resolveReaderAttachmentItemID(item) : null;
      setSidebarAttachment(body, attachmentItemID);
      setEnabled(tabType === "reader");
      if (attachmentItemID) ensurePaperPreparation(attachmentItemID);
      return true;
    },
    onRender: ({ body, item, tabType, setEnabled }) => {
      const attachmentItemID =
        tabType === "reader" ? resolveReaderAttachmentItemID(item) : null;
      setSidebarAttachment(body, attachmentItemID);
      setEnabled(tabType === "reader");
      if (tabType !== "reader") return;
      buildSidebar(body);
      if (attachmentItemID) {
        const cached = preparationErrors.get(attachmentItemID);
        if (
          cached &&
          contextErrorMatchesCurrent(attachmentItemID, cached.fullMdSha256)
        ) {
          publishPreparationError(
            attachmentItemID,
            cached.error,
            cached.fullMdSha256,
          );
        } else ensurePaperPreparation(attachmentItemID);
      }
      refreshPreparationSafely(body);
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
  registeredPaneKey = paneKey;
}

export function unregisterReaderSidebar(): void {
  if (!registeredPaneKey) return;
  Zotero.ItemPaneManager.unregisterSection(registeredPaneKey);
  registeredPaneKey = null;
  activeBodies.clear();
  preparationAttempts.clear();
  preparationErrors.clear();
  learningErrors.clear();
  learningMonitors.clear();
  paperContexts.clear();
}

export function updateReaderSidebar(): void {
  for (const body of activeBodies) updateSidebarBody(body);
}

export function synchronizeReaderSidebarContext(
  context: ValidatedPaperContext,
): void {
  const itemID = context.identity.attachmentID;
  if (!hasActiveBodyForItem(itemID)) return;
  storePaperContext(context);
  for (const body of activeBodies) {
    if (Number(body.dataset.itemId) !== itemID) continue;
    refreshPreparationSafely(body);
  }
}

export function monitorReaderSidebarLearning(
  context: ValidatedPaperContext,
  learning: Promise<void>,
): void {
  if (!hasActiveBodyForItem(context.identity.attachmentID)) {
    void learning.catch((error) =>
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      ),
    );
    return;
  }
  void observePaperLearning(context, learning).catch((error) =>
    publishPreparationError(
      context.identity.attachmentID,
      error,
      context.fullMdSha256,
    ),
  );
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
  const preparationHeader = element(
    doc,
    "div",
    `${config.addonRef}-preparation-header`,
  );
  Object.assign(preparationHeader.style, {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "6px",
  });
  const summary = element(doc, "div", `${config.addonRef}-preparation-summary`);
  Object.assign(summary.style, { flex: "1", fontWeight: "600" });
  const openDirectory = element(
    doc,
    "button",
    `${config.addonRef}-open-directory`,
  );
  openDirectory.type = "button";
  openDirectory.disabled = true;
  openDirectory.textContent = getString("sidebar-open-knowledge-directory");
  Object.assign(openDirectory.style, {
    padding: "2px 8px",
    border: "1px solid #77ad99",
    borderRadius: "10px",
    color: "#276553",
    background: "transparent",
    font: "inherit",
    fontSize: "0.82em",
    lineHeight: "1.5",
  });
  openDirectory.addEventListener("click", () => openKnowledgeDirectory(body));
  const files = element(doc, "div", `${config.addonRef}-preparation-files`);
  Object.assign(files.style, {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    fontSize: "0.9em",
  });
  preparationHeader.append(summary, openDirectory);
  preparation.append(preparationHeader, files);

  const source = element(doc, "textarea", `${config.addonRef}-sidebar-source`);
  source.rows = 5;
  source.placeholder = getString("sidebar-source-placeholder");
  applyTextareaStyle(source);
  source.addEventListener("input", () =>
    handleSidebarSourceInput(body, source.value),
  );
  const translate = element(
    doc,
    "button",
    `${config.addonRef}-sidebar-translate`,
  );
  translate.type = "button";
  translate.textContent = getString("readerpopup-translate-label");
  translate.addEventListener("click", () => {
    const itemId = Number(body.dataset.itemId);
    const input = normalizeTaskText(source.value);
    if (
      !Number.isInteger(itemId) ||
      itemId <= 0 ||
      !input ||
      body.dataset.paperReady !== "true"
    )
      return;
    const task = addTranslateTask(input, itemId);
    if (!task) return;
    body.dataset.sourceDirty = "false";
    body.dataset.sidebarTaskId = task.id;
    updateSidebarBody(body);
    dispatchTranslateTask(task);
  });
  const result = element(doc, "textarea", `${config.addonRef}-sidebar-result`);
  result.rows = 8;
  result.readOnly = true;
  result.placeholder = getString(getSidebarResultPlaceholderKey());
  applyTextareaStyle(result);
  container.append(card, preparation, source, translate, result);
  body.append(container);
  renderPreparation(body, createPreparationRecord("AAAAAAAA", "pending"));
  resetSidebarBody(body);
}

function setSidebarAttachment(
  body: HTMLElement,
  attachmentItemID: number | null,
): void {
  const previousItemID = Number(body.dataset.itemId);
  const nextItemID = attachmentItemID ? String(attachmentItemID) : "";
  if (body.dataset.itemId === nextItemID) return;
  invalidatePreparationRefresh(body);
  body.dataset.itemId = nextItemID;
  resetSidebarBody(body);
  if (!hasActiveBodyForItem(previousItemID))
    cancelActiveTranslation(previousItemID);
  releaseUnusedPaperContext(previousItemID);
}

function resetSidebarBody(body: HTMLElement): void {
  body.dataset.paperReady = "false";
  delete body.dataset.sourceDirty;
  delete body.dataset.sidebarTaskId;
  const title = body.querySelector(`.${config.addonRef}-paper-title`);
  const meta = body.querySelector(`.${config.addonRef}-paper-meta`);
  const badge = body.querySelector(
    `.${config.addonRef}-md-badge`,
  ) as HTMLElement | null;
  const source = body.querySelector(
    `.${config.addonRef}-sidebar-source`,
  ) as HTMLTextAreaElement | null;
  const result = body.querySelector(
    `.${config.addonRef}-sidebar-result`,
  ) as HTMLTextAreaElement | null;
  const translate = body.querySelector(
    `.${config.addonRef}-sidebar-translate`,
  ) as HTMLButtonElement | null;
  const openDirectory = body.querySelector(
    `.${config.addonRef}-open-directory`,
  ) as HTMLButtonElement | null;
  if (title) title.textContent = "";
  if (meta) meta.textContent = "";
  if (badge) badge.hidden = true;
  if (source) source.value = "";
  if (result) result.value = "";
  if (translate) translate.disabled = true;
  if (openDirectory) openDirectory.disabled = true;
  if (body.querySelector(`.${config.addonRef}-preparation-files`)) {
    renderPreparation(body, createPreparationRecord("AAAAAAAA", "pending"));
  }
}

function releaseUnusedPaperContext(itemID: number): void {
  if (!Number.isInteger(itemID) || itemID <= 0) return;
  if (preparationJobs.has(itemID)) return;
  if (hasActiveBodyForItem(itemID)) return;
  paperContexts.delete(itemID);
  preparationAttempts.delete(itemID);
  preparationErrors.delete(itemID);
  learningErrors.delete(itemID);
}

function hasActiveBodyForItem(itemID: number): boolean {
  return [...activeBodies].some(
    (body) => Number(body.dataset.itemId) === itemID,
  );
}

function openKnowledgeDirectory(body: HTMLElement): void {
  const itemID = Number(body.dataset.itemId);
  const context = paperContexts.get(itemID);
  if (!context) return;
  try {
    openPaperContextDirectory(context);
  } catch (error) {
    const reported = error instanceof Error ? error : new Error(String(error));
    Zotero.logError(reported);
    new ztoolkit.ProgressWindow(config.addonName)
      .createLine({
        type: "fail",
        text: `${getString("sidebar-open-directory-error")}: ${conciseError(reported)}`,
      })
      .show();
  }
}

export function openPaperContextDirectory(
  context: Pick<ValidatedPaperContext, "paperDir">,
): void {
  if (!context.paperDir.trim()) {
    throw new Error("Paper context directory is empty");
  }
  Zotero.launchFile(context.paperDir);
}

function ensurePaperPreparation(attachmentItemID: number): void {
  if (
    preparationJobs.has(attachmentItemID) ||
    preparationAttempts.has(attachmentItemID)
  )
    return;
  preparationAttempts.add(attachmentItemID);
  const job = preparePaper(attachmentItemID)
    .catch((error) => publishPreparationError(attachmentItemID, error))
    .finally(() => {
      preparationJobs.delete(attachmentItemID);
      releaseUnusedPaperContext(attachmentItemID);
    });
  preparationJobs.set(attachmentItemID, job);
}

async function preparePaper(attachmentItemID: number): Promise<void> {
  const context = await preparePaperContext(attachmentItemID, "");
  storePaperContext(context);
  await refreshMatchingBodies(attachmentItemID);
  const learning = continuePaperLearning(context);
  await observePaperLearning(context, learning);
}

function storePaperContext(context: ValidatedPaperContext): void {
  const itemID = context.identity.attachmentID;
  paperContexts.set(itemID, context);
  preparationAttempts.add(itemID);
  preparationErrors.delete(itemID);
  learningErrors.delete(itemID);
}

function observePaperLearning(
  context: ValidatedPaperContext,
  learning: Promise<void>,
): Promise<void> {
  const itemID = context.identity.attachmentID;
  const key = `${itemID}:${context.fullMdSha256}`;
  const active = learningMonitors.get(key);
  if (active) {
    void learning.catch((error) =>
      publishLearningError(itemID, context.fullMdSha256, error),
    );
    return active;
  }
  const job = observePaperLearningNow(
    itemID,
    context.fullMdSha256,
    learning,
  ).finally(() => {
    if (learningMonitors.get(key) === job) learningMonitors.delete(key);
  });
  learningMonitors.set(key, job);
  return job;
}

async function observePaperLearningNow(
  attachmentItemID: number,
  fullMdSha256: string,
  learning: Promise<void>,
): Promise<void> {
  let finished = false;
  const outcome: Promise<Error | null> = learning.then(
    () => {
      finished = true;
      return null;
    },
    (error) => {
      finished = true;
      return error instanceof Error ? error : new Error(String(error));
    },
  );
  while (!finished) {
    await new Promise<void>((resolve) => setTimeout(resolve, 750));
    await refreshMatchingBodies(attachmentItemID);
  }
  const error = await outcome;
  if (error) publishLearningError(attachmentItemID, fullMdSha256, error);
  else if (
    learningErrors.get(attachmentItemID)?.fullMdSha256 === fullMdSha256
  ) {
    learningErrors.delete(attachmentItemID);
  }
  await refreshMatchingBodies(attachmentItemID);
}

async function refreshMatchingBodies(itemID: number): Promise<void> {
  for (const body of activeBodies) {
    if (Number(body.dataset.itemId) !== itemID) continue;
    const fullMdSha256 = paperContexts.get(itemID)?.fullMdSha256;
    try {
      await refreshPreparation(body);
    } catch (error) {
      publishPreparationError(itemID, error, fullMdSha256);
    }
  }
}

async function refreshPreparation(body: HTMLElement): Promise<void> {
  const refreshVersion = invalidatePreparationRefresh(body);
  const itemID = Number(body.dataset.itemId);
  const context = paperContexts.get(itemID);
  if (!context) return;
  const fullMdSha256 = context.fullMdSha256;
  const isCurrent = () =>
    preparationRefreshIsCurrent({
      expectedVersion: refreshVersion,
      currentVersion: preparationRefreshVersions.get(body),
      expectedItemID: itemID,
      currentItemID: Number(body.dataset.itemId),
      expectedFullMdSha256: fullMdSha256,
      currentFullMdSha256: paperContexts.get(itemID)?.fullMdSha256,
    });
  let preparation: PreparationRecord;
  try {
    preparation = await readPreparationRecord(context);
  } catch (error) {
    if (!isCurrent()) return;
    throw error;
  }
  if (!isCurrent()) return;
  renderPaperCard(body, context);
  renderPreparation(body, preparation);
  preparationErrors.delete(itemID);
  const openDirectory = body.querySelector(
    `.${config.addonRef}-open-directory`,
  ) as HTMLButtonElement | null;
  if (openDirectory) openDirectory.disabled = false;
  updateSidebarBody(body);
}

function invalidatePreparationRefresh(body: HTMLElement): number {
  const next = (preparationRefreshVersions.get(body) || 0) + 1;
  preparationRefreshVersions.set(body, next);
  return next;
}

export function preparationRefreshIsCurrent(params: {
  expectedVersion: number;
  currentVersion?: number;
  expectedItemID: number;
  currentItemID: number;
  expectedFullMdSha256: string;
  currentFullMdSha256?: string;
}): boolean {
  return (
    params.currentVersion === params.expectedVersion &&
    params.currentItemID === params.expectedItemID &&
    params.currentFullMdSha256 === params.expectedFullMdSha256
  );
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
  const labels: Record<string, FluentMessageId> = {
    source: "sidebar-stage-source",
    index: "sidebar-stage-index",
    background: "sidebar-stage-background",
    terminology: "sidebar-stage-terminology",
    external: "sidebar-stage-external",
  };
  return record.stages.map((stage) => {
    const integrityIssue = record.integrityIssues?.find(
      (issue) => issue.stage === stage.id,
    );
    const status = integrityIssue ? "error" : stage.status;
    const detail = conciseStageDetail(integrityIssue?.detail ?? stage.detail);
    const suffix =
      status === "running"
        ? getString("sidebar-stage-running")
        : status === "warning"
          ? getString("sidebar-stage-warning", {
              args: {
                detail: detail || getString("sidebar-stage-warning-default"),
              },
            })
          : status === "error"
            ? getString("sidebar-stage-error", {
                args: {
                  detail: detail || getString("sidebar-stage-error-default"),
                },
              })
            : status === "skipped"
              ? getString("sidebar-stage-skipped", {
                  args: {
                    detail:
                      detail || getString("sidebar-stage-skipped-default"),
                  },
                })
              : "";
    return {
      status,
      text: getString("sidebar-stage-row", {
        args: {
          label: getString(labels[stage.id]),
          file: stage.file,
          suffix,
        },
      }),
    };
  });
}

export function isTranslationReady(record: PreparationRecord): boolean {
  return ["source", "index"].every(
    (id) =>
      record.stages.find((stage) => stage.id === id)?.status === "complete",
  );
}

function renderPreparation(body: HTMLElement, record: PreparationRecord): void {
  const summary = body.querySelector(`.${config.addonRef}-preparation-summary`);
  const files = body.querySelector(`.${config.addonRef}-preparation-files`);
  if (!summary || !files) return;
  const issueStages = new Set(
    (record.integrityIssues ?? []).map((issue) => issue.stage),
  );
  const hasError =
    issueStages.size > 0 ||
    record.stages.some((stage) => stage.status === "error");
  const completed = record.stages.filter(
    (stage) =>
      !issueStages.has(stage.id as "background" | "terminology" | "external") &&
      (["complete", "warning"].includes(stage.status) ||
        (!hasError && stage.status === "skipped")),
  ).length;
  summary.textContent = `${getString("sidebar-preparation-title")} ${completed}/${record.stages.length}${hasError ? ` · ${getString("sidebar-preparation-stopped")}` : ""}`;
  const learningError = learningErrors.get(Number(body.dataset.itemId));
  const currentHash = paperContexts.get(
    Number(body.dataset.itemId),
  )?.fullMdSha256;
  if (learningError && learningError.fullMdSha256 === currentHash) {
    summary.textContent += ` · ${getString("sidebar-preparation-error")}: ${conciseError(learningError.error)}`;
  }
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
  body.dataset.paperReady = String(isTranslationReady(record));
}

function publishPreparationError(
  itemID: number,
  error: unknown,
  fullMdSha256?: string,
): void {
  const reported = error instanceof Error ? error : new Error(String(error));
  if (!contextErrorMatchesCurrent(itemID, fullMdSha256)) {
    Zotero.logError(reported);
    return;
  }
  if (preparationErrors.get(itemID)?.error.message !== reported.message) {
    Zotero.logError(reported);
  }
  preparationErrors.set(itemID, { fullMdSha256, error: reported });
  for (const body of activeBodies) {
    if (Number(body.dataset.itemId) !== itemID) continue;
    const summary = body.querySelector(
      `.${config.addonRef}-preparation-summary`,
    );
    if (summary)
      summary.textContent = `${getString("sidebar-preparation-error")}: ${conciseError(reported)}`;
    const openDirectory = body.querySelector(
      `.${config.addonRef}-open-directory`,
    ) as HTMLButtonElement | null;
    if (openDirectory) openDirectory.disabled = !paperContexts.has(itemID);
    body.dataset.paperReady = "false";
    updateSidebarBody(body);
  }
}

function publishLearningError(
  itemID: number,
  fullMdSha256: string,
  error: unknown,
): void {
  const reported = error instanceof Error ? error : new Error(String(error));
  if (!contextErrorMatchesCurrent(itemID, fullMdSha256)) {
    Zotero.logError(reported);
    return;
  }
  if (learningErrors.get(itemID)?.error.message !== reported.message) {
    Zotero.logError(reported);
  }
  learningErrors.set(itemID, { fullMdSha256, error: reported });
  for (const body of activeBodies) {
    if (Number(body.dataset.itemId) !== itemID) continue;
    refreshPreparationSafely(body);
  }
}

function refreshPreparationSafely(body: HTMLElement): void {
  const itemID = Number(body.dataset.itemId);
  const fullMdSha256 = paperContexts.get(itemID)?.fullMdSha256;
  void refreshPreparation(body).catch((error) =>
    publishPreparationError(itemID, error, fullMdSha256),
  );
}

function contextErrorMatchesCurrent(
  itemID: number,
  fullMdSha256?: string,
): boolean {
  const current = paperContexts.get(itemID);
  if (!current) return fullMdSha256 === undefined;
  return fullMdSha256 === current.fullMdSha256;
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
  const knownTaskID = body.dataset.sidebarTaskId || "";
  let sourceDirty = body.dataset.sourceDirty === "true";
  if (sourceDirty && task && task.id !== knownTaskID) {
    sourceDirty = false;
    body.dataset.sourceDirty = "false";
  }
  if (!sourceDirty && task) body.dataset.sidebarTaskId = task.id;
  const paperReady = body.dataset.paperReady === "true";
  if (sourceDirty) {
    result.value = "";
    translate.disabled = !paperReady || !normalizeTaskText(source.value);
    return;
  }
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

function handleSidebarSourceInput(body: HTMLElement, value: string): void {
  const itemId = Number(body.dataset.itemId);
  const task = Number.isInteger(itemId)
    ? getLastTranslateTask({ itemId })
    : undefined;
  const normalized = normalizeTaskText(value);
  if (task && normalized === task.raw) {
    body.dataset.sourceDirty = "false";
    body.dataset.sidebarTaskId = task.id;
  } else {
    if (task?.status === "processing") cancelActiveTranslation(itemId);
    body.dataset.sourceDirty = String(Boolean(task) || Boolean(normalized));
    body.dataset.sidebarTaskId = task?.id || "";
  }
  updateSidebarBody(body);
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

function conciseStageDetail(detail?: string): string {
  return String(detail || "")
    .replace(/https?:\/\/\S+/g, "[URL omitted]")
    .slice(0, 80);
}

function applyTextareaStyle(textarea: HTMLTextAreaElement): void {
  Object.assign(textarea.style, {
    boxSizing: "border-box",
    width: "100%",
    height: "128px",
    minHeight: "128px",
    maxHeight: "128px",
    resize: "none",
    overflowY: "auto",
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
