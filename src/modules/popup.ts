import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { getLastTranslateTask } from "../utils/task";

export function updateReaderPopup() {
  const popup = addon.data.popup.currentPopup;
  if (!popup) return;
  const prefix = popup.getAttribute(`${config.addonRef}-prefix`);
  if (!prefix) return;
  const task = getLastTranslateTask({ type: "text" });
  if (!task) return;
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
  if (source.ownerDocument.activeElement !== source) source.value = task.raw;
  result.value = task.result;
  button.disabled = task.status === "processing";
  resize(result);
}

export function buildReaderPopup(
  event: _ZoteroTypes.Reader.EventParams<"renderTextSelectionPopup">,
) {
  const { reader, doc, append } = event;
  const popup = doc.querySelector(".selection-popup") as HTMLDivElement;
  const prefix = `${config.addonRef}-${reader._instanceID}`;
  addon.data.popup.currentPopup = popup;
  popup.style.maxWidth = "none";
  popup.setAttribute(`${config.addonRef}-prefix`, prefix);
  const textStyle = {
    boxSizing: "border-box",
    width: "320px",
    minWidth: "184px",
    marginInline: "2px",
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
          tag: "textarea",
          id: `${prefix}-source`,
          attributes: { rows: "3", placeholder: "Source text" },
          classList: [`${config.addonRef}-readerpopup`],
          styles: { ...textStyle, background: "var(--color-sidepane)" },
          properties: {
            value: addon.data.translate.selectedText,
            spellcheck: false,
            onpointerup: (event: Event) => event.stopPropagation(),
          },
          listeners: [
            {
              type: "input",
              listener: (event) => {
                const task = getLastTranslateTask({ type: "text" });
                if (!task) return;
                task.raw = (event.target as HTMLTextAreaElement).value;
                task.result = "";
                task.status = "waiting";
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
          properties: { innerHTML: getString("readerpopup-translate-label") },
          listeners: [
            {
              type: "click",
              listener: () =>
                addon.hooks.onTranslate({
                  noCheckZoteroItemLanguage: true,
                  noCache: true,
                }),
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
            placeholder: getString("status-translating"),
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
    }),
  );
}

function resize(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "30px";
  textarea.style.height = `${Math.max(30, textarea.scrollHeight + 3)}px`;
}
