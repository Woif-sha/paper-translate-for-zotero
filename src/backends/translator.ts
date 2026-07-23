import { runLegacyCodexRequest } from "../codex/legacyClient";
import { preparePaperContext, readPreparationRecord } from "../context/runtime";
import { continuePaperLearning } from "../context/research";
import {
  TRANSLATION_DEVELOPER_INSTRUCTIONS,
  buildTranslationPrompt,
} from "../context/prompts";
import { getPref } from "../utils/prefs";
import {
  monitorReaderSidebarLearning,
  synchronizeReaderSidebarContext,
} from "../modules/sidebar";

type PaperLearningScheduleDependencies = {
  readAttemptId(
    context: Parameters<typeof readPreparationRecord>[0],
  ): Promise<number>;
  continueLearning(
    context: Parameters<typeof continuePaperLearning>[0],
  ): Promise<void>;
  monitor(
    context: Parameters<typeof monitorReaderSidebarLearning>[0],
    learning: Promise<void>,
    attemptId: number,
  ): void;
  report(error: unknown): void;
};

let activeTranslation:
  | { attachmentItemID: number; controller: AbortController }
  | undefined;

export function cancelActiveTranslation(attachmentItemID?: number): void {
  if (
    attachmentItemID !== undefined &&
    activeTranslation?.attachmentItemID !== attachmentItemID
  )
    return;
  activeTranslation?.controller.abort();
  activeTranslation = undefined;
}

export async function translateWithPaperContext(params: {
  attachmentItemID: number;
  sourceLanguage: string;
  targetLanguage: string;
  input: string;
  onUpdate(text: string): void;
}): Promise<string> {
  activeTranslation?.controller.abort();
  const controller = new AbortController();
  activeTranslation = {
    attachmentItemID: params.attachmentItemID,
    controller,
  };
  try {
    const context = await preparePaperContext(
      params.attachmentItemID,
      params.input,
    );
    synchronizeReaderSidebarContext(context);
    const input = context.alignedQuery || params.input;
    const prompt = buildTranslationPrompt({
      context,
      sourceLanguage: params.sourceLanguage,
      targetLanguage: params.targetLanguage,
      input,
    });
    const translation = await translateWithCodex(
      prompt,
      input,
      controller.signal,
      params.onUpdate,
    );
    schedulePaperLearningAfterTranslation(context);
    return translation;
  } finally {
    if (activeTranslation?.controller === controller)
      activeTranslation = undefined;
  }
}

export function schedulePaperLearningAfterTranslation(
  context: Parameters<typeof readPreparationRecord>[0],
  dependencies: PaperLearningScheduleDependencies = {
    async readAttemptId(value) {
      return (await readPreparationRecord(value)).attemptId;
    },
    continueLearning: continuePaperLearning,
    monitor: monitorReaderSidebarLearning,
    report(error) {
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
    },
  },
): void {
  void Promise.resolve()
    .then(async () => {
      const attemptId = await dependencies.readAttemptId(context);
      const learning = dependencies.continueLearning(context);
      dependencies.monitor(context, learning, attemptId);
    })
    .catch((error) => dependencies.report(error));
}

async function translateWithCodex(
  prompt: string,
  source: string,
  signal: AbortSignal,
  onUpdate: (text: string) => void,
): Promise<string> {
  const result = await runLegacyCodexRequest({
    apiUrl: requiredPref("paper.codexApiUrl"),
    model: requiredPref("paper.codexModel"),
    effort: String(getPref("paper.codexEffort") || ""),
    instructions: TRANSLATION_DEVELOPER_INSTRUCTIONS,
    prompt,
    signal,
    onDelta: (_delta, accumulated) =>
      onUpdate(formatTranslationLayout(source, accumulated)),
  });
  return formatTranslationLayout(source, result.text);
}

export function formatTranslationLayout(
  source: string,
  translation: string,
): string {
  const sourceBulletLayout = classifySourceBullets(source);
  if (!sourceBulletLayout.includes("list")) return translation;
  const translationBulletCount = translation.match(/[•●▪◦‣]/gu)?.length ?? 0;
  const hasInlineBullet = sourceBulletLayout.includes("inline");
  if (hasInlineBullet && translationBulletCount !== sourceBulletLayout.length) {
    return translation;
  }
  let bulletIndex = 0;
  return translation
    .replace(/\s*([•●▪◦‣])\s*/gu, (match, bullet: string, offset: number) => {
      if (sourceBulletLayout[bulletIndex++] === "inline") return match;
      return `${offset > 0 ? "\n" : ""}${bullet} `;
    })
    .trim();
}

function classifySourceBullets(value: string): Array<"list" | "inline"> {
  const layout: Array<"list" | "inline"> = [];
  for (const match of value.matchAll(/[•●▪◦‣]/gu)) {
    const offset = match.index;
    const lineStart = value.lastIndexOf("\n", offset - 1) + 1;
    layout.push(value.slice(lineStart, offset).trim() ? "inline" : "list");
  }
  return layout;
}

function requiredPref(key: string): string {
  const value = String(getPref(key) || "").trim();
  if (!value) throw new Error(`Required preference is empty: ${key}`);
  return value;
}
