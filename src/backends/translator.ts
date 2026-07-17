import { runLegacyCodexRequest } from "../codex/legacyClient";
import {
  TerminologyEntry,
  ValidatedPaperContext,
  persistTerminology,
  preparePaperContext,
} from "../context/runtime";
import { continuePaperLearning } from "../context/research";
import {
  TERMINOLOGY_DEVELOPER_INSTRUCTIONS,
  TRANSLATION_DEVELOPER_INSTRUCTIONS,
  buildTerminologyPrompt,
  buildTranslationPrompt,
} from "../context/prompts";
import { getPref } from "../utils/prefs";
let activeController: AbortController | null = null;

export function cancelActiveTranslation(): void {
  activeController?.abort();
  activeController = null;
}

export async function translateWithPaperContext(params: {
  attachmentItemID: number;
  sourceLanguage: string;
  targetLanguage: string;
  input: string;
  onUpdate(text: string): void;
}): Promise<string> {
  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;
  try {
    const context = await preparePaperContext(
      params.attachmentItemID,
      params.input,
    );
    const prompt = buildTranslationPrompt({
      context,
      sourceLanguage: params.sourceLanguage,
      targetLanguage: params.targetLanguage,
      input: params.input,
    });
    const translation = await translateWithCodex(
      prompt,
      params.input,
      controller.signal,
      params.onUpdate,
    );
    void continuePaperLearning(context).catch((error) =>
      Zotero.logError(error),
    );
    void updateTerminology(context, params.input, translation).catch((error) =>
      Zotero.logError(error),
    );
    return translation;
  } finally {
    if (activeController === controller) activeController = null;
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
  if (!/[•●▪◦‣]/u.test(source)) return translation;
  return translation
    .replace(
      /\s*([•●▪◦‣])\s*/gu,
      (_match, bullet, offset) => `${offset > 0 ? "\n" : ""}${bullet} `,
    )
    .trim();
}

async function updateTerminology(
  context: ValidatedPaperContext,
  input: string,
  translation: string,
): Promise<void> {
  const result = await runLegacyCodexRequest({
    apiUrl: requiredPref("paper.codexApiUrl"),
    model: requiredPref("paper.codexModel"),
    effort: String(getPref("paper.codexEffort") || ""),
    instructions: TERMINOLOGY_DEVELOPER_INSTRUCTIONS,
    prompt: buildTerminologyPrompt({ context, input, translation }),
  });
  await persistTerminology({
    context,
    entries: parseTerminologyResult(result.text).filter((entry) =>
      input.toLocaleLowerCase().includes(entry.observed.toLocaleLowerCase()),
    ),
  });
}

export function parseTerminologyResult(value: string): TerminologyEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `Codex terminology extraction returned invalid JSON: ${String(error)}`,
    );
  }
  const entries = (parsed as { entries?: unknown })?.entries;
  if (!Array.isArray(entries))
    throw new Error("Codex terminology result has no entries array");
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== "object")
      throw new Error(`Terminology entry ${index} is invalid`);
    const item = entry as Record<string, unknown>;
    if (
      typeof item.observed !== "string" ||
      typeof item.canonical !== "string" ||
      typeof item.translation !== "string" ||
      typeof item.category !== "string" ||
      typeof item.definition !== "string"
    ) {
      throw new Error(`Terminology entry ${index} is incomplete`);
    }
    return {
      observed: item.observed,
      canonical: item.canonical,
      translation: item.translation,
      category: item.category,
      definition: item.definition,
      evidence: "Selected text",
      sourceLevel: "paper",
      confidence: "medium",
    };
  });
}

function requiredPref(key: string): string {
  const value = String(getPref(key) || "").trim();
  if (!value) throw new Error(`Required preference is empty: ${key}`);
  return value;
}
