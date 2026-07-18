import { version } from "../package.json";
import { FIXED_TARGET_LANGUAGE } from "./constants";
import {
  getLastTranslateTask,
  normalizeTaskText,
  TranslateTask,
} from "./utils/task";

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
  if (options.langto && options.langto !== FIXED_TARGET_LANGUAGE) {
    throw new Error(
      `[Paper Translate for Zotero: api.translate] target language is fixed to ${FIXED_TARGET_LANGUAGE}`,
    );
  }
  raw = normalizeTaskText(raw);
  if (!raw) {
    throw new Error(
      "[Paper Translate for Zotero: api.translate] source text is empty",
    );
  }
  const task: TranslateTask = {
    id: `${Zotero.Utilities.randomString()}-${Date.now()}`,
    type: "text",
    raw,
    result: "",
    service: "paper-context",
    itemId: options.itemID,
    status: "waiting",
    langfrom: options.langfrom,
    langto: FIXED_TARGET_LANGUAGE,
    callerID: options.pluginID,
  };
  await addon.data.translate.services.runTranslationTask(task, {
    noDisplay: true,
  });
  return task;
}

function getTemporaryRefreshHandler(options?: { task?: TranslateTask }) {
  const task = options?.task;
  return () => {
    if (task?.itemId) {
      const current = getLastTranslateTask({ itemId: task.itemId });
      if (current?.id !== task.id) return;
    }
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
