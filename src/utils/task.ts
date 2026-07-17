import { inferLanguage, matchLanguage } from "./config";
import { getString } from "./locale";
import { getPref } from "./prefs";
import { getServiceSecret } from "./secret";
import { config } from "../../package.json";
import Addon from "../addon";

export interface TranslateTask {
  /**
   * Task id.
   */
  id: string;
  /**
   * Task type.
   */
  type: "text";
  /**
   * Raw text for translation.
   */
  raw: string;
  /**
   * Translation result or error info.
   */
  result: string;
  /**
   * Service id.
   */
  service: string;
  /**
   * Zotero item id.
   *
   * For language disable check.
   */
  itemId: number | undefined;
  /**
   * From language
   *
   * Generated at task runtime.
   */
  langfrom?: string;
  /**
   * To language.
   *
   * Generated at task runtime.
   */
  langto?: string;
  /**
   * Whether the from language is inferred.
   */
  langfromInferred?: boolean;
  /**
   * Service secret.
   *
   * Generated at task runtime.
   */
  secret?: string;
  /**
   * task status.
   */
  status: "waiting" | "processing" | "success" | "fail";
  /**
   * Caller identifier.
   *
   * This is for translate service provider to identify the caller.
   * If not provided, the call will fail.
   */
  callerID?: string;
  /**
   * If the task is once processed.
   */
  processed?: boolean;
}

export type TranslateTaskProcessor = (
  data: Required<TranslateTask>,
) => Promise<void> | void;

function maskAccessToken(token: string): string {
  if (!token) return token;

  const length = token.length;
  if (length <= 2) return "*".repeat(length);

  const visible = length <= 6 ? 1 : 3;
  const maskedLength = length - visible * 2;

  if (maskedLength <= 0) {
    return "*".repeat(length);
  }

  return `${token.slice(0, visible)}${"*".repeat(maskedLength)}${token.slice(
    length - visible,
  )}`;
}

export function sanitizeTaskForLog(task: TranslateTask): TranslateTask {
  return {
    ...task,
    ...(task.secret ? { secret: maskAccessToken(task.secret) } : {}),
  };
}

export class TranslateTaskRunner {
  protected processor: TranslateTaskProcessor;
  constructor(processor: TranslateTaskProcessor) {
    this.processor = processor;
  }

  public async run(data: TranslateTask) {
    // @ts-ignore - Plugin instance is not typed
    const addon = Zotero[config.addonInstance] as Addon;
    const ztoolkit = addon.data.ztoolkit;
    if (!data.langfrom || !data.langto) {
      ztoolkit.log("try auto detect language");
      const { fromLanguage, toLanguage, isInferred } = autoDetectLanguage(
        Zotero.Items.get(data.itemId || -1),
      );
      data.langfrom = data.langfrom || fromLanguage;
      data.langto = data.langto || toLanguage;
      if (isInferred) {
        data.langfromInferred = true;
      }
    }

    // If the task is not new, update language settings
    if (data.processed) {
      updateTranslateTaskLang(data);
    }

    data.callerID = data.callerID || config.addonID;

    data.secret = getServiceSecret(data.service);
    data.status = "processing";
    try {
      ztoolkit.log(sanitizeTaskForLog(data));
      await this.processor(data as Required<TranslateTask>);
      data.status = "success";
    } catch (e) {
      data.result = this.makeErrorInfo(data.service, String(e));
      data.status = "fail";
    }
    data.processed = true;
  }

  protected makeErrorInfo(serviceId: string, detail: string) {
    return `${getString("service-errorPrefix")} ${getString(
      `service-${serviceId}`,
    )}\n\n${detail}`;
  }
}

export function addTranslateTask(
  raw: string,
  itemId?: number,
  type?: TranslateTask["type"],
  service?: string,
) {
  if (!raw) {
    return;
  }
  // @ts-ignore - Plugin instance is not typed
  const addon = Zotero[config.addonInstance] as Addon;
  type = type || "text";
  // Filter raw string

  // eslint-disable-next-line no-control-regex
  raw = raw.replace(/[\u0000-\u001F\u007F-\u009F]/gu, " ").normalize("NFKC");

  // Create a new task
  const newTask: TranslateTask = {
    id: `${Zotero.Utilities.randomString()}-${new Date().getTime()}`,
    type,
    raw,
    result: "",
    service: "",
    itemId,
    status: "waiting",
  };

  if (!service) {
    setDefaultService(newTask);
  } else {
    newTask.service = service;
  }

  addon.data.translate.queue.push(newTask);
  // Keep queue size
  cleanTasks();
  return newTask;
}

function setDefaultService(task: TranslateTask) {
  task.service = "paper-context";
}

function cleanTasks() {
  // @ts-ignore - Plugin instance is not typed
  const addon = Zotero[config.addonInstance] as Addon;

  if (
    addon.data.translate.queue.length > addon.data.translate.maximumQueueLength
  ) {
    addon.data.translate.queue.splice(
      0,
      Math.floor(addon.data.translate.maximumQueueLength / 3),
    );
  }
}

export function getTranslateTasks(count: number) {
  // @ts-ignore - Plugin instance is not typed
  return (Zotero[config.addonInstance] as Addon).data.translate.queue.slice(
    -count,
  );
}

export function getLastTranslateTask<
  K extends keyof TranslateTask,
  V extends TranslateTask[K],
>(conditions?: { [key in K]: V }) {
  // @ts-ignore - Plugin instance is not typed
  const queue = (Zotero[config.addonInstance] as Addon).data.translate.queue;
  let i = queue.length - 1;
  while (i >= 0) {
    const currentTask = queue[i];
    const notMatchConditions =
      conditions &&
      Object.keys(conditions)
        .map((key) => currentTask[key as K] === conditions[key as K])
        .includes(false);
    if (!notMatchConditions) {
      return queue[i];
    }
    i--;
  }
  return undefined;
}

/**
 * Update the task with the latest language settings.
 */
export function updateTranslateTaskLang(task: TranslateTask) {
  if (!task.langfromInferred) {
    task.langfrom = getPref("sourceLanguage") as string;
  }
  task.langto = getPref("targetLanguage") as string;
}

export function autoDetectLanguage(item: Zotero.Item | null) {
  if (!item) {
    return {
      fromLanguage: getPref("sourceLanguage") as string,
      toLanguage: getPref("targetLanguage") as string,
    };
  }
  // @ts-ignore - Plugin instance is not typed
  const addon = Zotero[config.addonInstance] as Addon;
  const ztoolkit = addon.data.ztoolkit;
  const topItem = Zotero.Items.getTopLevel([item])[0];
  const fromLanguage = getPref("sourceLanguage") as string;
  const toLanguage = getPref("targetLanguage") as string;
  let detectedFromLanguage = fromLanguage;
  // Use cached source language
  const sourceLanguageCache =
    addon.data.translate.cachedSourceLanguage[item.id];
  if (sourceLanguageCache && sourceLanguageCache !== toLanguage) {
    return {
      fromLanguage: sourceLanguageCache,
      toLanguage,
    };
  }
  let isInferred = false;
  if (getPref("enableAutoDetectLanguage")) {
    if (topItem) {
      let itemLanguage: string =
        // Respect language field
        matchLanguage((topItem.getField("language") as string) || "").code;
      ztoolkit.log("try itemLanguage", itemLanguage);
      if (!itemLanguage) {
        // Respect AbstractNote or Title inferred language
        const inferredLanguage = inferLanguage(
          (topItem.getField("abstractNote") as string) ||
            (topItem.getField("title") as string) ||
            "",
        ).code;
        ztoolkit.log("try inferredLanguage", inferredLanguage);
        if (inferredLanguage) {
          itemLanguage = inferredLanguage;
        }
      }
      const itemLanguageMajor = itemLanguage.split("-")[0];
      if (
        itemLanguage &&
        ![fromLanguage, toLanguage].find(
          (lang) => lang.split("-")[0] === itemLanguageMajor,
        )
      ) {
        ztoolkit.log("use autoDetect", itemLanguage);
        // If the item language is not the same as the target/source language, use it
        detectedFromLanguage = itemLanguage;
        isInferred = true;
      }
    }
  }
  return {
    fromLanguage: detectedFromLanguage,
    toLanguage,
    isInferred,
  };
}
