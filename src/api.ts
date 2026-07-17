import { version } from "../package.json";
import { TranslateTask } from "./utils/task";

async function translate(
  raw: string,
  options: {
    pluginID: string;
    itemID: number;
    langfrom?: string;
    langto?: string;
  },
): Promise<TranslateTask> {
  if (!options?.pluginID)
    throw new Error(
      "[Paper Translate for Zotero: api.translate] pluginID is required",
    );
  if (!options.itemID)
    throw new Error(
      "[Paper Translate for Zotero: api.translate] Reader attachment itemID is required",
    );
  const task: TranslateTask = {
    id: `${Zotero.Utilities.randomString()}-${Date.now()}`,
    type: "text",
    raw,
    result: "",
    service: "paper-context",
    itemId: options.itemID,
    status: "waiting",
    langfrom: options.langfrom,
    langto: options.langto,
    callerID: options.pluginID,
  };
  await addon.data.translate.services.runTranslationTask(task, {
    noDisplay: true,
    noCache: true,
  });
  return task;
}

function getTemporaryRefreshHandler(options?: { task?: TranslateTask }) {
  const tick = `${Zotero.Utilities.randomString()}-${Date.now()}`;
  addon.data.translate.refreshTick = tick;
  return () => {
    if (addon.data.translate.refreshTick === tick)
      addon.hooks.onReaderPopupRefresh();
  };
}

export default {
  translate,
  getServices: () =>
    addon.data.translate.services
      .getAllServices()
      .map((service) => ({ ...service })),
  getVersion: () => version,
  getTemporaryRefreshHandler,
};
