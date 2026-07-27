import { config } from "../../package.json";
import {
  continuePaperLearning,
  startPaperLearningRetry,
  stopPaperLearning,
} from "../context/research";
import {
  MINERU_TOKEN_URL,
  MineruMarkdownUnavailableError,
  PreparationRecord,
  PreparationRetryScope,
  ValidatedPaperContext,
  createPreparationRecord,
  getPreparationRetryScope,
  preparationHasRunningKnowledge,
  preparePaperContext,
  readPreparationRecord,
} from "../context/runtime";
import { getLocaleID, getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import {
  addTranslateTask,
  dispatchTranslateTask,
  getLastTranslateTask,
  normalizeTaskText,
  TranslateTask,
} from "../utils/task";
import { PREFERENCES_PANE_ID } from "./preferenceWindow";
import { cancelActiveTranslation } from "../backends/translator";
import {
  cancelImageTextRecognition,
  imageTextRecognitionIsActive,
  startImageTextRecognition,
  type ImageTextRecognitionState,
} from "../ocr/controller";
import { FluentMessageId } from "../../typings/i10n";
import {
  ensureTranslationDisplayStyles,
  renderTranslationDisplay,
} from "./translationDisplay";

const activeBodies = new Set<HTMLElement>();
const preparationJobs = new Map<number, Promise<void>>();
const preparationActionJobs = new Map<number, Promise<void>>();
const preparationAttempts = new Set<number>();
type ContextErrorRecord = { fullMdSha256?: string; error: Error };
type LearningErrorRecord = ContextErrorRecord & { attemptId: number };
const preparationErrors = new Map<number, ContextErrorRecord>();
const learningErrors = new Map<number, LearningErrorRecord>();
const learningMonitors = new Map<string, Promise<void>>();
const paperContexts = new Map<number, ValidatedPaperContext>();
const imageRecognitionStates = new Map<number, ImageTextRecognitionState>();
const preparationRefreshVersions = new WeakMap<HTMLElement, number>();
let registeredPaneKey: string | null = null;

export type SidebarPreparationAction =
  | "stop"
  | "retry-core"
  | "retry-external"
  | null;

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
      if (!hasActiveBodyForItem(itemID)) {
        cancelActiveTranslation(itemID);
        cancelImageTextRecognition(itemID);
        imageRecognitionStates.delete(itemID);
      }
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
  preparationActionJobs.clear();
  paperContexts.clear();
  imageRecognitionStates.clear();
  cancelImageTextRecognition();
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
  attemptId: number,
): void {
  if (!hasActiveBodyForItem(context.identity.attachmentID)) {
    void learning.catch((error) =>
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      ),
    );
    return;
  }
  void observePaperLearning(context, learning, attemptId).catch((error) =>
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
  ensureTranslationDisplayStyles(doc);
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
    flexWrap: "wrap",
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
  applyCompactActionStyle(openDirectory);
  openDirectory.addEventListener("click", () => openKnowledgeDirectory(body));
  const preparationAction = element(
    doc,
    "button",
    `${config.addonRef}-preparation-action`,
  );
  preparationAction.type = "button";
  preparationAction.hidden = true;
  applyCompactActionStyle(preparationAction);
  preparationAction.addEventListener("click", () => runPreparationAction(body));
  const files = element(doc, "div", `${config.addonRef}-preparation-files`);
  Object.assign(files.style, {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    fontSize: "0.9em",
  });
  const mineruReminder = element(
    doc,
    "div",
    `${config.addonRef}-mineru-reminder`,
  );
  mineruReminder.hidden = true;
  Object.assign(mineruReminder.style, {
    marginTop: "7px",
    color: "var(--fill-secondary)",
    fontSize: "0.85em",
    lineHeight: "1.45",
  });
  preparationHeader.append(summary, preparationAction, openDirectory);
  preparation.append(preparationHeader, files, mineruReminder);

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
    if (Number.isInteger(itemId) && itemId > 0) {
      cancelImageTextRecognition(itemId);
    }
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
  const result = element(
    doc,
    "div",
    `${config.addonRef}-sidebar-result ${config.addonRef}-translation-display`,
  );
  result.setAttribute("role", "textbox");
  result.setAttribute("aria-readonly", "true");
  result.tabIndex = 0;
  applyResultStyle(result);
  renderTranslationDisplay(
    result,
    "",
    getString(getSidebarResultPlaceholderKey()),
  );
  const imageTools = element(doc, "div", `${config.addonRef}-image-tools`);
  Object.assign(imageTools.style, {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    minHeight: "28px",
  });
  const imageSelect = element(doc, "button", `${config.addonRef}-image-select`);
  imageSelect.type = "button";
  imageSelect.disabled = true;
  imageSelect.title = getString("sidebar-image-select-title");
  imageSelect.textContent = `▧ ${getString("sidebar-image-select")}`;
  applyCompactActionStyle(imageSelect);
  imageSelect.addEventListener("click", () => runImageTextSelection(body));
  const imageStatus = element(doc, "span", `${config.addonRef}-image-status`);
  imageStatus.hidden = true;
  Object.assign(imageStatus.style, {
    flex: "1",
    minWidth: "0",
    color: "var(--fill-secondary)",
    fontSize: "0.82em",
    lineHeight: "1.35",
    overflowWrap: "anywhere",
  });
  imageTools.append(imageSelect, imageStatus);
  container.append(card, preparation, imageTools, source, translate, result);
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
  if (!hasActiveBodyForItem(previousItemID)) {
    cancelActiveTranslation(previousItemID);
    cancelImageTextRecognition(previousItemID);
    imageRecognitionStates.delete(previousItemID);
  }
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
  ) as HTMLElement | null;
  const translate = body.querySelector(
    `.${config.addonRef}-sidebar-translate`,
  ) as HTMLButtonElement | null;
  const imageSelect = body.querySelector(
    `.${config.addonRef}-image-select`,
  ) as HTMLButtonElement | null;
  const imageStatus = body.querySelector(
    `.${config.addonRef}-image-status`,
  ) as HTMLElement | null;
  const openDirectory = body.querySelector(
    `.${config.addonRef}-open-directory`,
  ) as HTMLButtonElement | null;
  const preparationAction = body.querySelector(
    `.${config.addonRef}-preparation-action`,
  ) as HTMLButtonElement | null;
  const mineruReminder = body.querySelector(
    `.${config.addonRef}-mineru-reminder`,
  ) as HTMLElement | null;
  if (title) title.textContent = "";
  if (meta) meta.textContent = "";
  if (badge) badge.hidden = true;
  if (source) source.value = "";
  if (result)
    renderTranslationDisplay(
      result,
      "",
      getString(getSidebarResultPlaceholderKey()),
    );
  if (translate) translate.disabled = true;
  if (imageSelect) imageSelect.disabled = true;
  if (imageStatus) {
    imageStatus.hidden = true;
    imageStatus.textContent = "";
  }
  if (openDirectory) openDirectory.disabled = true;
  if (preparationAction) {
    preparationAction.hidden = true;
    preparationAction.disabled = false;
    delete preparationAction.dataset.action;
  }
  if (mineruReminder) {
    mineruReminder.hidden = true;
    mineruReminder.replaceChildren();
  }
  if (body.querySelector(`.${config.addonRef}-preparation-files`)) {
    renderPreparation(body, createPreparationRecord("AAAAAAAA", "pending"));
  }
}

function releaseUnusedPaperContext(itemID: number): void {
  if (!Number.isInteger(itemID) || itemID <= 0) return;
  if (preparationJobs.has(itemID)) return;
  if (preparationActionJobs.has(itemID)) return;
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

function runImageTextSelection(body: HTMLElement): void {
  const itemID = Number(body.dataset.itemId);
  if (
    !Number.isInteger(itemID) ||
    itemID <= 0 ||
    body.dataset.paperReady !== "true" ||
    !paperContexts.has(itemID) ||
    imageTextRecognitionIsActive(itemID)
  ) {
    return;
  }
  let reader: unknown;
  try {
    reader = resolveActiveReaderForAttachment(itemID);
  } catch (error) {
    publishImageRecognitionError(itemID, error);
    return;
  }
  cancelActiveTranslation(itemID);
  void startImageTextRecognition({
    attachmentItemID: itemID,
    reader,
    instruction: getString("sidebar-image-selecting"),
    cancelLabel: getString("sidebar-image-cancel"),
    onStateChange: (state) => setImageRecognitionState(itemID, state),
  })
    .then((text) => {
      if (!text) return;
      const task = addTranslateTask(text, itemID);
      if (!task) {
        throw new Error("Image OCR produced no translatable text");
      }
      for (const currentBody of activeBodies) {
        if (Number(currentBody.dataset.itemId) !== itemID) continue;
        currentBody.dataset.sourceDirty = "false";
        currentBody.dataset.sidebarTaskId = task.id;
      }
      updateReaderSidebar();
      if (getPref("enableAuto")) dispatchTranslateTask(task);
    })
    .catch((error) => {
      if (isAbortError(error)) return;
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
      if (imageRecognitionStates.get(itemID)?.phase !== "error") {
        publishImageRecognitionError(itemID, error);
      }
    });
}

function setImageRecognitionState(
  itemID: number,
  state: ImageTextRecognitionState,
): void {
  if (state.phase === "idle") {
    imageRecognitionStates.delete(itemID);
  } else {
    imageRecognitionStates.set(itemID, state);
  }
  for (const body of activeBodies) {
    if (Number(body.dataset.itemId) !== itemID) continue;
    updateSidebarBody(body);
  }
}

function publishImageRecognitionError(itemID: number, error: unknown): void {
  setImageRecognitionState(itemID, {
    phase: "error",
    detail: conciseError(error),
  });
}

function renderImageRecognition(
  body: HTMLElement,
  state: ImageTextRecognitionState = { phase: "idle" },
): void {
  const status = body.querySelector(
    `.${config.addonRef}-image-status`,
  ) as HTMLElement | null;
  if (!status) return;
  if (state.phase === "idle") {
    status.hidden = true;
    status.textContent = "";
    return;
  }
  status.hidden = false;
  status.dataset.phase = state.phase;
  status.style.color =
    state.phase === "error" ? "#a32626" : "var(--fill-secondary)";
  status.textContent =
    state.phase === "selecting"
      ? getString("sidebar-image-selecting")
      : state.phase === "recognizing"
        ? getString("sidebar-image-recognizing")
        : getString("sidebar-image-error-detail", {
            args: { detail: formatImageRecognitionError(state.detail) },
          });
}

function formatImageRecognitionError(detail?: string): string {
  return detail === "Codex OCR response contained no visible text"
    ? getString("sidebar-image-no-text")
    : detail || getString("sidebar-stage-error-default");
}

function resolveActiveReaderForAttachment(attachmentItemID: number): unknown {
  const tabs = ztoolkit.getGlobal("Zotero_Tabs") as { selectedID?: string };
  if (!tabs.selectedID) throw new Error("No active Zotero Reader tab");
  const reader = Zotero.Reader.getByTabID(tabs.selectedID);
  if (Number(reader?.itemID) !== attachmentItemID) {
    throw new Error("The active Reader does not match this paper");
  }
  return reader;
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

export function getSidebarPreparationAction(
  record: PreparationRecord,
): SidebarPreparationAction {
  if (preparationHasRunningKnowledge(record)) return "stop";
  const scope = getPreparationRetryScope(record);
  return scope === "core"
    ? "retry-core"
    : scope === "external"
      ? "retry-external"
      : null;
}

function runPreparationAction(body: HTMLElement): void {
  const itemID = Number(body.dataset.itemId);
  if (!Number.isInteger(itemID) || itemID <= 0) return;
  if (preparationActionJobs.has(itemID)) return;
  const button = body.querySelector(
    `.${config.addonRef}-preparation-action`,
  ) as HTMLButtonElement | null;
  const action = button?.dataset.action;
  if (!action) return;
  button.disabled = true;
  const job =
    action === "recheck"
      ? recheckPaperPreparation(itemID)
      : runKnowledgePreparationAction(
          itemID,
          action as Exclude<SidebarPreparationAction, null>,
        );
  const tracked = job
    .catch(async (error) => {
      const context = paperContexts.get(itemID);
      if (context) {
        try {
          const preparation = await readPreparationRecord(context);
          publishLearningError(
            itemID,
            context.fullMdSha256,
            preparation.attemptId,
            error,
          );
        } catch (readError) {
          publishPreparationError(
            itemID,
            new AggregateError(
              [error, readError],
              "Knowledge action failed and preparation state could not be read",
            ),
            context.fullMdSha256,
          );
        }
      } else {
        publishPreparationError(itemID, error);
      }
    })
    .finally(() => {
      if (preparationActionJobs.get(itemID) === tracked) {
        preparationActionJobs.delete(itemID);
      }
      const cached = preparationErrors.get(itemID);
      if (cached && !paperContexts.has(itemID)) {
        publishPreparationError(itemID, cached.error, cached.fullMdSha256);
      } else {
        refreshMatchingBodies(itemID).catch((error) =>
          publishPreparationError(
            itemID,
            error,
            paperContexts.get(itemID)?.fullMdSha256,
          ),
        );
      }
      releaseUnusedPaperContext(itemID);
    });
  preparationActionJobs.set(itemID, tracked);
}

async function recheckPaperPreparation(itemID: number): Promise<void> {
  await preparationJobs.get(itemID)?.catch(() => undefined);
  preparationAttempts.delete(itemID);
  preparationErrors.delete(itemID);
  learningErrors.delete(itemID);
  preparationAttempts.add(itemID);
  const context = await preparePaperContext(itemID, "");
  storePaperContext(context);
  await refreshMatchingBodies(itemID);
  const preparation = await readPreparationRecord(context);
  monitorReaderSidebarLearning(
    context,
    continuePaperLearning(context),
    preparation.attemptId,
  );
}

async function runKnowledgePreparationAction(
  itemID: number,
  action: Exclude<SidebarPreparationAction, null>,
): Promise<void> {
  const context = paperContexts.get(itemID);
  if (!context) throw new Error("Paper context is unavailable");
  learningErrors.delete(itemID);
  if (action === "stop") {
    await stopPaperLearning(context);
    return;
  }
  const scope: PreparationRetryScope =
    action === "retry-core" ? "core" : "external";
  const { attemptId, learning } = await startPaperLearningRetry(context, scope);
  monitorReaderSidebarLearning(context, learning, attemptId);
}

function ensurePaperPreparation(attachmentItemID: number): void {
  if (
    preparationJobs.has(attachmentItemID) ||
    preparationActionJobs.has(attachmentItemID) ||
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
  const preparation = await readPreparationRecord(context);
  const learning = continuePaperLearning(context);
  await observePaperLearning(context, learning, preparation.attemptId);
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
  attemptId: number,
): Promise<void> {
  const itemID = context.identity.attachmentID;
  const key = getLearningMonitorKey(itemID, context.fullMdSha256, attemptId);
  const active = learningMonitors.get(key);
  if (active) {
    void learning.catch((error) =>
      publishLearningError(itemID, context.fullMdSha256, attemptId, error),
    );
    return active;
  }
  const job = observePaperLearningNow(
    itemID,
    context.fullMdSha256,
    attemptId,
    learning,
  ).finally(() => {
    if (learningMonitors.get(key) === job) learningMonitors.delete(key);
  });
  learningMonitors.set(key, job);
  return job;
}

export function getLearningMonitorKey(
  itemID: number,
  fullMdSha256: string,
  attemptId: number,
): string {
  return `${itemID}:${fullMdSha256}:${attemptId}`;
}

async function observePaperLearningNow(
  attachmentItemID: number,
  fullMdSha256: string,
  attemptId: number,
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
  if (error) {
    publishLearningError(attachmentItemID, fullMdSha256, attemptId, error);
  } else {
    const current = learningErrors.get(attachmentItemID);
    if (
      current?.fullMdSha256 === fullMdSha256 &&
      current.attemptId <= attemptId
    ) {
      learningErrors.delete(attachmentItemID);
    }
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

export function getCompletedPreparationStageCount(
  record: PreparationRecord,
): number {
  const issueStages = new Set(
    (record.integrityIssues ?? []).map((issue) => issue.stage),
  );
  const hasError =
    issueStages.size > 0 ||
    record.stages.some((stage) => stage.status === "error");
  return record.stages.filter(
    (stage) =>
      !issueStages.has(stage.id as "background" | "terminology" | "external") &&
      (stage.status === "complete" ||
        (!hasError && stage.status === "skipped")),
  ).length;
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
  const completed = getCompletedPreparationStageCount(record);
  summary.textContent = `${getString("sidebar-preparation-title")} ${completed}/${record.stages.length}${hasError ? ` · ${getString("sidebar-preparation-stopped")}` : ""}`;
  const learningError = learningErrors.get(Number(body.dataset.itemId));
  const currentHash = paperContexts.get(
    Number(body.dataset.itemId),
  )?.fullMdSha256;
  if (
    learningError &&
    learningError.fullMdSha256 === currentHash &&
    learningError.attemptId === record.attemptId
  ) {
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
  renderPreparationAction(body, getSidebarPreparationAction(record));
  hideMineruReminder(body);
}

function renderPreparationAction(
  body: HTMLElement,
  action: SidebarPreparationAction | "recheck",
): void {
  const button = body.querySelector(
    `.${config.addonRef}-preparation-action`,
  ) as HTMLButtonElement | null;
  if (!button) return;
  if (!action) {
    button.hidden = true;
    button.disabled = false;
    delete button.dataset.action;
    return;
  }
  const messageID: FluentMessageId =
    action === "stop"
      ? "sidebar-preparation-stop"
      : action === "retry-external"
        ? "sidebar-preparation-retry-external"
        : action === "retry-core"
          ? "sidebar-preparation-retry"
          : "sidebar-preparation-recheck";
  button.dataset.action = action;
  button.textContent = getString(messageID);
  button.hidden = false;
  button.disabled = preparationActionJobs.has(Number(body.dataset.itemId));
}

function hideMineruReminder(body: HTMLElement): void {
  const reminder = body.querySelector(
    `.${config.addonRef}-mineru-reminder`,
  ) as HTMLElement | null;
  if (!reminder) return;
  reminder.hidden = true;
  reminder.replaceChildren();
}

function renderMineruReminder(
  body: HTMLElement,
  error: MineruMarkdownUnavailableError,
): void {
  const reminder = body.querySelector(
    `.${config.addonRef}-mineru-reminder`,
  ) as HTMLElement | null;
  if (!reminder) return;
  const doc = body.ownerDocument;
  const text = element(doc, "span", `${config.addonRef}-mineru-reminder-text`);
  text.textContent =
    error.reason === "not-generated"
      ? getString("sidebar-mineru-not-generated")
      : getString("sidebar-mineru-incomplete", {
          args: { files: error.missingFiles.join(", ") },
        });
  reminder.replaceChildren(text);
  if (error.reason === "not-generated") {
    const link = element(doc, "button", `${config.addonRef}-mineru-token-link`);
    link.type = "button";
    link.textContent = getString("sidebar-mineru-token-link");
    Object.assign(link.style, {
      marginInlineStart: "4px",
      padding: "0",
      border: "0",
      color: "#168c68",
      background: "transparent",
      textDecoration: "underline",
      font: "inherit",
      cursor: "pointer",
    });
    link.addEventListener("click", () => Zotero.launchURL(MINERU_TOKEN_URL));
    reminder.append(link);
  }
  reminder.hidden = false;
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
    if (reported instanceof MineruMarkdownUnavailableError) {
      renderPreparationAction(body, "recheck");
      renderMineruReminder(body, reported);
    } else {
      renderPreparationAction(body, null);
      hideMineruReminder(body);
    }
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
  attemptId: number,
  error: unknown,
): void {
  const reported = error instanceof Error ? error : new Error(String(error));
  if (!contextErrorMatchesCurrent(itemID, fullMdSha256)) {
    Zotero.logError(reported);
    return;
  }
  const existing = learningErrors.get(itemID);
  if (
    existing?.fullMdSha256 === fullMdSha256 &&
    existing.attemptId > attemptId
  ) {
    Zotero.logError(reported);
    return;
  }
  if (
    existing?.error.message !== reported.message ||
    existing.attemptId !== attemptId
  ) {
    Zotero.logError(reported);
  }
  learningErrors.set(itemID, { fullMdSha256, attemptId, error: reported });
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
  ) as HTMLElement | null;
  const translate = body.querySelector(
    `.${config.addonRef}-sidebar-translate`,
  ) as HTMLButtonElement | null;
  const imageSelect = body.querySelector(
    `.${config.addonRef}-image-select`,
  ) as HTMLButtonElement | null;
  if (!source || !result || !translate) return;
  const placeholder = getString(getSidebarResultPlaceholderKey());
  renderImageRecognition(
    body,
    imageRecognitionStates.get(itemId) || { phase: "idle" },
  );
  if (!Number.isInteger(itemId) || itemId <= 0) {
    renderTranslationDisplay(
      result,
      getString("sidebar-no-attachment"),
      placeholder,
    );
    translate.disabled = true;
    if (imageSelect) imageSelect.disabled = true;
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
  if (imageSelect) {
    imageSelect.disabled =
      !paperReady ||
      !paperContexts.has(itemId) ||
      imageTextRecognitionIsActive(itemId);
  }
  if (sourceDirty) {
    renderTranslationDisplay(result, "", placeholder);
    translate.disabled = !paperReady || !normalizeTaskText(source.value);
    return;
  }
  if (!task) {
    renderTranslationDisplay(result, "", placeholder);
    translate.disabled = !paperReady || !source.value.trim();
    return;
  }
  if (source.ownerDocument.activeElement !== source) source.value = task.raw;
  renderTranslationDisplay(
    result,
    task.result,
    getString(getSidebarResultPlaceholderKey(task.status)),
  );
  translate.disabled = !paperReady || task.status === "processing";
}

function handleSidebarSourceInput(body: HTMLElement, value: string): void {
  const itemId = Number(body.dataset.itemId);
  if (Number.isInteger(itemId) && itemId > 0) {
    cancelImageTextRecognition(itemId);
  }
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function conciseStageDetail(detail?: string): string {
  return String(detail || "")
    .replace(/https?:\/\/\S+/g, "[URL omitted]")
    .slice(0, 80);
}

function applyCompactActionStyle(button: HTMLButtonElement): void {
  Object.assign(button.style, {
    padding: "2px 8px",
    border: "1px solid #77ad99",
    borderRadius: "10px",
    color: "#276553",
    background: "transparent",
    font: "inherit",
    fontSize: "0.82em",
    lineHeight: "1.5",
    whiteSpace: "nowrap",
  });
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

function applyResultStyle(result: HTMLElement): void {
  Object.assign(result.style, {
    boxSizing: "border-box",
    width: "100%",
    height: "128px",
    minHeight: "128px",
    maxHeight: "128px",
    overflowY: "auto",
    border: "1px solid var(--fill-quinary)",
    borderRadius: "6px",
    padding: "8px",
    color: "var(--fill-primary)",
    background: "var(--material-background)",
    font: "inherit",
    userSelect: "text",
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
