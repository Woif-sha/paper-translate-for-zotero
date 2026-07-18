import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import {
  addTranslateTask,
  dispatchTranslateTask,
  getLastTranslateTask,
  normalizeTaskText,
} from "../utils/task";
import { cancelActiveTranslation } from "../backends/translator";

export function updateReaderPopup() {
  const popup = addon.data.popup.currentPopup;
  if (!popup) return;
  const prefix = popup.getAttribute(`${config.addonRef}-prefix`);
  if (!prefix) return;
  const itemId = Number(
    popup.getAttribute(`${config.addonRef}-attachment-item-id`),
  );
  if (!Number.isInteger(itemId) || itemId <= 0) return;
  const source = popup.querySelector(
    `#${prefix}-source`,
  ) as HTMLTextAreaElement | null;
  const result = popup.querySelector(
    `#${prefix}-result`,
  ) as HTMLTextAreaElement | null;
  const button = popup.querySelector(
    `#${prefix}-translate`,
  ) as HTMLButtonElement | null;
  if (!source || !result || !button) return;
  const task = getPopupTask(popup, itemId);
  if (!task) {
    result.value = "";
    result.placeholder = getString("sidebar-result-placeholder");
    button.disabled = true;
    return;
  }
  if (source.ownerDocument.activeElement !== source) source.value = task.raw;
  result.value = task.result;
  result.placeholder = getString(
    task.status === "processing"
      ? "status-translating"
      : "sidebar-result-placeholder",
  );
  button.disabled = task.status === "processing" || !task.raw.trim();
}

export function buildReaderPopup(
  event: _ZoteroTypes.Reader.EventParams<"renderTextSelectionPopup">,
  taskId?: string,
) {
  const { reader, doc, append } = event;
  const itemId = Number(reader.itemID);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    throw new Error("Reader popup has no attachment item ID");
  }
  const popup = doc.querySelector(".selection-popup") as HTMLDivElement;
  const prefix = `${config.addonRef}-${reader._instanceID}`;
  addon.data.popup.currentPopup = popup;
  popup.style.maxWidth = "none";
  popup.setAttribute(`${config.addonRef}-prefix`, prefix);
  popup.setAttribute(`${config.addonRef}-attachment-item-id`, String(itemId));
  if (taskId) {
    popup.setAttribute(`${config.addonRef}-task-id`, taskId);
  } else {
    popup.removeAttribute(`${config.addonRef}-task-id`);
  }
  const panelStyle = {
    boxSizing: "border-box",
    display: "grid",
    gridTemplateRows: "minmax(48px, 1fr) auto minmax(48px, 1fr)",
    gap: "4px",
    width: "320px",
    height: "226px",
    minWidth: "280px",
    minHeight: "150px",
    maxWidth: "min(720px, calc(100vw - 24px))",
    maxHeight: "min(720px, calc(100vh - 24px))",
    resize: "both",
    overflow: "hidden",
    padding: "2px",
  };
  const textStyle = {
    boxSizing: "border-box",
    width: "100%",
    minWidth: "0",
    height: "100%",
    minHeight: "0",
    resize: "none",
    overflowY: "auto",
    border: "none",
    borderRadius: "6px",
    padding: "6px",
    fontFamily: "inherit",
    fontSize: `${getPref("fontSize")}px`,
    lineHeight: `${Number(getPref("lineHeight")) * Number(getPref("fontSize"))}px`,
  };
  append(
    ztoolkit.UI.createElement(doc, "fragment", {
      children: [
        {
          tag: "div",
          namespace: "html",
          id: `${prefix}-panel`,
          classList: [`${config.addonRef}-readerpopup-panel`],
          styles: panelStyle,
          properties: {
            onpointerdown: (event: Event) => event.stopPropagation(),
            onpointerup: (event: Event) => event.stopPropagation(),
          },
          children: [
            {
              tag: "textarea",
              id: `${prefix}-source`,
              attributes: { rows: "3", placeholder: "Source text" },
              classList: [`${config.addonRef}-readerpopup`],
              styles: {
                ...textStyle,
                background: "var(--color-sidepane)",
              },
              properties: {
                value: addon.data.translate.selectedText,
                spellcheck: false,
                onpointerup: (event: Event) => event.stopPropagation(),
              },
              listeners: [
                {
                  type: "input",
                  listener: (event) => {
                    const raw = (event.target as HTMLTextAreaElement).value;
                    updatePopupSourceTask(popup, itemId, raw);
                    updateReaderPopup();
                  },
                },
              ],
              ignoreIfExists: true,
            },
            {
              tag: "button",
              namespace: "html",
              id: `${prefix}-translate`,
              classList: [
                "toolbar-button",
                "wide-button",
                `${config.addonRef}-readerpopup`,
              ],
              properties: {
                innerHTML: getString("readerpopup-translate-label"),
                disabled: !taskId,
              },
              listeners: [
                {
                  type: "click",
                  listener: () => {
                    const task = getPopupTask(popup, itemId);
                    if (!task) return;
                    dispatchTranslateTask(task);
                  },
                },
              ],
              ignoreIfExists: true,
            },
            {
              tag: "textarea",
              id: `${prefix}-result`,
              attributes: {
                rows: "3",
                readonly: "true",
                placeholder: getString("sidebar-result-placeholder"),
              },
              classList: [`${config.addonRef}-readerpopup`],
              styles: { ...textStyle, background: "transparent" },
              properties: {
                spellcheck: false,
                onpointerup: (event: Event) => event.stopPropagation(),
              },
              ignoreIfExists: true,
            },
          ],
          ignoreIfExists: true,
        },
      ],
    }),
  );
}

export function updatePopupSourceTask(
  popup: Element,
  itemId: number,
  raw: string,
) {
  const normalized = normalizeTaskText(raw);
  let task = getPopupTask(popup, itemId);
  if (task?.status === "processing") {
    cancelActiveTranslation(itemId);
    task = undefined;
  }
  if (!task) {
    const replacement = normalized
      ? addTranslateTask(normalized, itemId)
      : undefined;
    if (replacement) {
      popup.setAttribute(`${config.addonRef}-task-id`, replacement.id);
    } else {
      popup.removeAttribute(`${config.addonRef}-task-id`);
    }
    return replacement;
  }
  task.raw = normalized;
  task.result = "";
  task.status = "waiting";
  return task;
}

function getPopupTask(popup: Element, itemId: number) {
  const taskId = popup.getAttribute(`${config.addonRef}-task-id`);
  if (!taskId) return undefined;
  return getLastTranslateTask({ id: taskId, type: "text", itemId });
}
