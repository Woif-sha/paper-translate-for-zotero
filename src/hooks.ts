import { config } from "../package.json";
import { initLocale } from "./utils/locale";
import {
  registerPrefsScripts,
  registerPrefsWindow,
} from "./modules/preferenceWindow";
import { buildReaderPopup, updateReaderPopup } from "./modules/popup";
import { registerNotify } from "./modules/notify";
import { registerReaderInitializer } from "./modules/reader";
import { getPref } from "./utils/prefs";
import {
  addTranslateTask,
  getLastTranslateTask,
  TranslateTask,
} from "./utils/task";
import { setDefaultPrefSettings } from "./modules/defaultPrefs";
import Addon from "./addon";
import { cleanupPermanentlyDeletedPaperContexts } from "./context/runtime";
import { cancelActiveTranslation } from "./backends/translator";
import { closeCodexClient } from "./codex/appServer";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  // TODO: Remove this after zotero#3387 is merged
  if (__env__ === "development") {
    // Keep in sync with the scripts/startup.mjs
    const loadDevToolWhen = `Plugin ${config.addonID} startup`;
    ztoolkit.log(loadDevToolWhen);
  }

  initLocale();

  setDefaultPrefSettings();

  registerReaderInitializer();
  registerNotify(["item"]);
  registerPrefsWindow();

  await cleanupPermanentlyDeletedPaperContexts();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );
}

async function onMainWindowLoad(_win: Window): Promise<void> {}

async function onMainWindowUnload(_win: Window): Promise<void> {}

async function onShutdown(): Promise<void> {
  cancelActiveTranslation();
  await closeCodexClient();
  ztoolkit.unregisterAll();
  Zotero.getMainWindows().forEach((win) => {
    onMainWindowUnload(win);
  });
  // Remove addon object
  addon.data.alive = false;
  // @ts-ignore - Plugin instance is not typed
  delete Zotero[config.addonInstance];
}

/**
 * This function is just an example of dispatcher for Notify events.
 * Any operations should be placed in a function to keep this function clear.
 */
async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  if (type === "item" && event === "delete") {
    await cleanupPermanentlyDeletedPaperContexts();
  }
}

function onPrefsLoad(event: Event) {
  registerPrefsScripts((event.target as any).ownerGlobal);
}

async function onTranslate(): Promise<void>;
async function onTranslate(
  options: Parameters<
    Addon["data"]["translate"]["services"]["runTranslationTask"]
  >["1"],
): Promise<void>;
async function onTranslate(
  task: TranslateTask | undefined,
  options?: Parameters<
    Addon["data"]["translate"]["services"]["runTranslationTask"]
  >["1"],
): Promise<void>;
async function onTranslate(...data: any) {
  let task = undefined;
  let options = {};
  if (data.length === 1) {
    if (data[0].raw) {
      task = data[0];
    } else {
      options = data[0];
    }
  } else if (data.length === 2) {
    task = data[0];
    options = data[1];
  }
  await addon.data.translate.services.runTranslationTask(task, options);
}

function onReaderPopupShow(
  event: _ZoteroTypes.Reader.EventParams<"renderTextSelectionPopup">,
) {
  const selection = addon.data.translate.selectedText;
  cancelActiveTranslation();
  const task = getLastTranslateTask();
  if (task?.raw === selection) {
    buildReaderPopup(event);
    addon.hooks.onReaderPopupRefresh();
    return;
  }
  addTranslateTask(selection, event.reader.itemID);
  buildReaderPopup(event);
  addon.hooks.onReaderPopupRefresh();
  if (getPref("enableAuto")) {
    addon.hooks.onTranslate();
  }
}

function onReaderPopupRefresh() {
  updateReaderPopup();
}

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintain.

export default {
  onStartup,
  onMainWindowLoad,
  onMainWindowUnload,
  onShutdown,
  onNotify,
  onPrefsLoad,
  onTranslate,
  onReaderPopupShow,
  onReaderPopupRefresh,
};
