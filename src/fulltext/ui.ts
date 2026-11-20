import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import { modelErrorMessage } from "../models/runtime";
import {
  isFulltextRunning,
  pauseFulltext,
  startFulltext,
  stopFulltext,
} from "./job";
import { createFulltextToolbarIcon } from "./toolbarIcon";
import { appendFulltextReadingModes } from "./readingModes";

const menuId = config.addonRef + "-fulltext";
let registered = false;

export function registerFulltextUI(): void {
  if (registered) return;
  Zotero.MenuManager?.registerMenu({
    menuID: menuId,
    pluginID: config.addonID,
    target: "main/library/item",
    menus: [
      {
        menuType: "submenu",
        l10nID: getLocaleID("fulltext-menu"),
        onShowing(_event, context) {
          const item =
            context.items?.length === 1 ? context.items[0] : undefined;
          context.setVisible(
            !!item && (item.isRegularItem() || item.isPDFAttachment()),
          );
        },
        menus: [
          {
            menuType: "menuitem",
            l10nID: getLocaleID("fulltext-start"),
            onShowing(_event, context) {
              context.setEnabled(
                !isSelectedTranslationRunning(context.items?.[0]),
              );
            },
            onCommand(_event, context) {
              showErrors(async () => {
                const item = context.items?.[0];
                if (item) await openFulltext(resolvePdf(item).id);
              });
            },
          },
          {
            menuType: "menuitem",
            l10nID: getLocaleID("fulltext-pause"),
            onShowing(_event, context) {
              context.setEnabled(
                isSelectedTranslationRunning(context.items?.[0]),
              );
            },
            onCommand(_event, context) {
              showErrors(async () => {
                const item = context.items?.[0];
                if (item) pauseFulltext(resolvePdf(item).id);
              });
            },
          },
        ],
      },
    ],
  });
  Zotero.Reader.registerEventListener(
    "renderToolbar",
    onRenderToolbar,
    config.addonID,
  );
  registered = true;
}

export async function unregisterFulltextUI(): Promise<void> {
  if (registered) {
    Zotero.Reader.unregisterEventListener("renderToolbar", onRenderToolbar);
    Zotero.MenuManager?.unregisterMenu(menuId);
    registered = false;
  }
  await stopFulltext();
}

function isSelectedTranslationRunning(item: Zotero.Item | undefined): boolean {
  if (!item) return false;
  try {
    return isFulltextRunning(resolvePdf(item).id);
  } catch {
    // Item selections without a single target PDF have no active command.
    return false;
  }
}

function resolvePdf(item: Zotero.Item): Zotero.Item {
  if (item.isPDFAttachment() && item.parentItemID) return item;
  if (!item.isRegularItem()) throw new Error(getString("fulltext-source-pdf"));
  const pdfs = Zotero.Items.get(item.getAttachments()).filter(
    (child) => !child.deleted && child.isPDFAttachment(),
  );
  if (pdfs.length !== 1)
    throw new Error(
      getString(pdfs.length ? "fulltext-multiple-pdfs" : "fulltext-source-pdf"),
    );
  return pdfs[0];
}

const onRenderToolbar: _ZoteroTypes.Reader.EventHandler<"renderToolbar"> = ({
  reader,
  doc,
  append,
}) => {
  const attachmentId = Number(reader.itemID);
  const item = Zotero.Items.get(attachmentId);
  if (!item || !item.parentItemID) return;
  if (
    item.attachmentReaderType === "snapshot" &&
    /^paper-translate-[A-Z0-9]{8}\.bilingual\.html$/u.test(
      item.attachmentFilename,
    )
  ) {
    appendFulltextReadingModes(doc, append, () => {
      const views = (
        reader._internalReader as unknown as {
          _views?: Array<{ _initOutline?: () => void }>;
        }
      )._views;
      for (const view of views ?? []) view._initOutline?.();
    });
    return;
  }
  if (!item.isPDFAttachment()) return;
  const button = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
  button.setAttribute("type", "button");
  button.setAttribute("class", "toolbar-button");
  button.append(createFulltextToolbarIcon(doc));
  button.title = getString("fulltext-toolbar");
  button.setAttribute("aria-label", button.title);
  button.addEventListener("click", () =>
    showErrors(() => toggleFulltext(attachmentId)),
  );
  append(button);
};

async function toggleFulltext(attachmentId: number): Promise<void> {
  if (isFulltextRunning(attachmentId)) {
    pauseFulltext(attachmentId);
    return;
  }
  await openFulltext(attachmentId);
}

async function openFulltext(attachmentId: number): Promise<void> {
  if (isFulltextRunning(attachmentId)) return;
  const popup = new ztoolkit.ProgressWindow(getString("fulltext-start"), {
    closeOnClick: false,
    closeOtherProgressWindows: false,
  })
    .createLine({ text: getString("fulltext-source"), progress: 0 })
    .show(-1);
  try {
    await startFulltext(attachmentId, ({ phase, model, done, total }) => {
      const text =
        phase === "source"
          ? getString("fulltext-source")
          : phase === "output"
            ? getString("fulltext-output")
            : getString("fulltext-progress", {
                args: { done: done ?? 0, total: total ?? 0 },
              });
      popup.changeLine({
        text: text + " · " + model,
        progress: total ? (100 * (done ?? 0)) / total : undefined,
      });
    });
    popup.changeLine({ text: getString("fulltext-complete"), progress: 100 });
  } catch (error) {
    // Shared transports may wrap the AbortSignal reason.
    const message = modelErrorMessage(error);
    popup.changeLine({
      type: message.includes("全文翻译已暂停") ? "default" : "fail",
      text: message,
    });
  } finally {
    popup.startCloseTimer(14000);
  }
}

function showErrors(action: () => Promise<void>): void {
  void action().catch((error) =>
    Zotero.alert(
      Zotero.getMainWindow(),
      getString("fulltext-start"),
      modelErrorMessage(error),
    ),
  );
}
