import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import { modelErrorMessage } from "../models/runtime";
import {
  isFulltextRunning,
  pauseFulltext,
  startFulltext,
  stopFulltext,
} from "./job";

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
        menuType: "menuitem",
        l10nID: getLocaleID("fulltext-start"),
        onShowing(_event, context) {
          const item =
            context.items?.length === 1 ? context.items[0] : undefined;
          context.setVisible(
            !!item && (item.isRegularItem() || item.isPDFAttachment()),
          );
        },
        onCommand(_event, context) {
          showErrors(async () => {
            const item = context.items?.[0];
            if (item) await toggleFulltext(resolvePdf(item).id);
          });
        },
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
  if (!item || !item.isPDFAttachment() || !item.parentItemID) return;
  const button = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
  button.setAttribute("type", "button");
  button.setAttribute("class", "toolbar-button");
  button.textContent = "文";
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
  const popup = new ztoolkit.ProgressWindow(getString("fulltext-start"), {
    closeOnClick: false,
    closeOtherProgressWindows: false,
  })
    .createLine({ text: getString("fulltext-source"), progress: 0 })
    .show(-1);
  try {
    const attachment = await startFulltext(
      attachmentId,
      ({ phase, model, done, total }) => {
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
      },
    );
    const pane = Zotero.getActiveZoteroPane() as {
      viewAttachment?(id: number): Promise<void>;
    } | null;
    if (pane?.viewAttachment) {
      await pane.viewAttachment(attachment.id);
    } else {
      const file = await attachment.getFilePathAsync();
      if (file) Zotero.launchFile(file);
    }
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
