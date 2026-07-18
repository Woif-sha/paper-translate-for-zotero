import { runLegacyCodexRequest } from "../codex/legacyClient";
import { preparePaperContext } from "../context/runtime";
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
    const learning = continuePaperLearning(context);
    monitorReaderSidebarLearning(context, learning);
    return translation;
  } finally {
    if (activeTranslation?.controller === controller)
      activeTranslation = undefined;
  }
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
