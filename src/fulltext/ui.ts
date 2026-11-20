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
const confirmationDurationMs = 2000;
let registered = false;
const queuedPdfs = new Map<number, Zotero.Item>();
let processedPdfs = 0;
let drainingQueue = false;
let activeProgress: InstanceType<typeof ztoolkit.ProgressWindow> | undefined;
let queueNotice: InstanceType<typeof ztoolkit.ProgressWindow> | undefined;

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
          const items = context.items ?? [];
          context.setVisible(
            items.length > 0 &&
              items.every(
                (item) => item.isRegularItem() || item.isPDFAttachment(),
              ),
          );
        },
        menus: [
          {
            menuType: "menuitem",
            l10nID: getLocaleID("fulltext-start"),
            onShowing(_event, context) {
              context.setEnabled(
                context.items?.some(canQueueSelection) ?? false,
              );
            },
            onCommand(_event, context) {
              showErrors(() =>
                enqueuePdfs((context.items ?? []).map(resolvePdf)),
              );
            },
          },
          {
            menuType: "menuitem",
            l10nID: getLocaleID("fulltext-pause"),
            onShowing(_event, context) {
              context.setEnabled(isFulltextRunning());
            },
            onCommand() {
              pauseTranslation();
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
  queuedPdfs.clear();
  processedPdfs = 0;
  queueNotice?.close();
  queueNotice = undefined;
  const popup = activeProgress;
  activeProgress = undefined;
  popup?.close();
  await stopFulltext();
}

function canQueueSelection(item: Zotero.Item): boolean {
  try {
    const pdf = resolvePdf(item);
    return canQueuePdf(pdf.id);
  } catch {
    // The command reports why an item cannot be resolved to a single PDF.
    return true;
  }
}

function canQueuePdf(id: number): boolean {
  return !queuedPdfs.has(id) && !isFulltextRunning(id);
}

async function enqueuePdfs(pdfs: readonly Zotero.Item[]): Promise<void> {
  if (!pdfs.length) return;
  const previousCount = queuedPdfs.size;
  for (const pdf of pdfs) {
    if (canQueuePdf(pdf.id)) queuedPdfs.set(pdf.id, pdf);
  }
  const added = queuedPdfs.size - previousCount;
  if (added && (previousCount || added > 1)) {
    activeProgress?.changeHeadline(queueProgressHeading());
    showQueueNotice(added);
  }
  if (drainingQueue) return;
  drainingQueue = true;
  try {
    for (const pdf of queuedPdfs.values()) {
      if ((await openFulltext(pdf)) && queuedPdfs.delete(pdf.id)) {
        processedPdfs++;
      }
    }
  } finally {
    drainingQueue = false;
    if (!queuedPdfs.size) processedPdfs = 0;
  }
}

function queueProgressHeading(): string {
  const current = processedPdfs + 1;
  const total = processedPdfs + queuedPdfs.size;
  return getString("fulltext-start") + " · " + current + "/" + total;
}

function showQueueNotice(count: number): void {
  queueNotice?.close();
  const popup = new ztoolkit.ProgressWindow(getString("fulltext-start"))
    .createLine({
      text: getString("fulltext-queued", { args: { count } }),
      progress: 100,
    })
    .show(-1);
  queueNotice = popup;
  setTimeout(() => {
    if (queueNotice !== popup) return;
    queueNotice = undefined;
    popup.close();
  }, confirmationDurationMs);
}

function pauseTranslation(): void {
  if (!isFulltextRunning()) return;
  queuedPdfs.clear();
  processedPdfs = 0;
  pauseFulltext();
  const popup = activeProgress;
  if (!popup) return;
  activeProgress = undefined;
  popup.changeLine({
    idx: 1,
    text: getString("fulltext-paused"),
    progress: 100,
  });
  setTimeout(() => popup.close(), confirmationDurationMs);
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
    showErrors(() => toggleFulltext(item)),
  );
  append(button);
};

async function toggleFulltext(pdf: Zotero.Item): Promise<void> {
  if (isFulltextRunning(pdf.id)) {
    pauseTranslation();
    return;
  }
  await enqueuePdfs([pdf]);
}

async function openFulltext(pdf: Zotero.Item): Promise<boolean> {
  const popup = new ztoolkit.ProgressWindow(queueProgressHeading(), {
    closeOnClick: false,
    closeOtherProgressWindows: false,
  })
    .createLine({ text: pdf.getDisplayTitle(), progress: 100 })
    .createLine({ text: getString("fulltext-source"), progress: 0 })
    .show(-1);
  activeProgress = popup;
  try {
    await startFulltext(pdf.id, ({ phase, done, total }) => {
      if (activeProgress !== popup) return;
      const text =
        phase === "source"
          ? getString("fulltext-source")
          : phase === "output"
            ? getString("fulltext-output")
            : getString("fulltext-progress", {
                args: { done: done ?? 0, total: total ?? 0 },
              });
      popup.changeLine({
        idx: 1,
        text,
        progress: total ? (100 * (done ?? 0)) / total : undefined,
      });
    });
    if (activeProgress !== popup) return false;
    if (queuedPdfs.size === 1) {
      popup.changeLine({
        idx: 1,
        text: getString("fulltext-complete"),
        progress: 100,
      });
      setTimeout(() => popup.close(), confirmationDurationMs);
    } else {
      popup.close();
    }
  } catch (error) {
    if (activeProgress !== popup) return false;
    popup.changeLine({
      idx: 1,
      type: "fail",
      text: modelErrorMessage(error),
      progress: 100,
    });
    popup.startCloseTimer(8000);
  } finally {
    if (activeProgress === popup) activeProgress = undefined;
  }
  return true;
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
