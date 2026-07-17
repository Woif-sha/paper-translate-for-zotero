import { getCodexClient, normalizeEffort } from "../codex/appServer";
import {
  TerminologyEntry,
  ValidatedPaperContext,
  persistTerminology,
  preparePaperContext,
} from "../context/runtime";
import { ensureBackgroundResearch } from "../context/research";
import {
  TERMINOLOGY_DEVELOPER_INSTRUCTIONS,
  TRANSLATION_DEVELOPER_INSTRUCTIONS,
  buildTerminologyPrompt,
  buildTranslationPrompt,
} from "../context/prompts";
import { getPref } from "../utils/prefs";
import { OpenAIProtocol, streamOpenAITranslation } from "./openaiCompatible";

type TranslationBackend = "codex" | OpenAIProtocol;

const translationThreads = new Map<string, string>();
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
  apiKey: string;
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
    await ensureBackgroundResearch(context, controller.signal);
    const prompt = buildTranslationPrompt({
      context,
      sourceLanguage: params.sourceLanguage,
      targetLanguage: params.targetLanguage,
      input: params.input,
    });
    const backend = requiredBackend();
    const translation =
      backend === "codex"
        ? await translateWithCodex(
            context,
            prompt,
            params.targetLanguage,
            controller.signal,
            params.onUpdate,
          )
        : await streamOpenAITranslation({
            protocol: backend,
            endpoint: requiredPref("paper.apiEndpoint"),
            apiKey: params.apiKey,
            model: requiredPref("paper.apiModel"),
            temperature: requiredTemperature(),
            prompt,
            signal: controller.signal,
            onDelta: (_delta, accumulated) => params.onUpdate(accumulated),
          });
    await updateTerminology(
      context,
      params.input,
      translation,
      controller.signal,
    );
    return translation;
  } finally {
    if (activeController === controller) activeController = null;
  }
}

async function translateWithCodex(
  context: ValidatedPaperContext,
  prompt: string,
  targetLanguage: string,
  signal: AbortSignal,
  onUpdate: (text: string) => void,
): Promise<string> {
  const client = await getCodexClient(getPref("paper.codexPath") as string);
  const model = requiredPref("paper.codexModel");
  const key = [
    context.identity.libraryID,
    context.identity.parentItemKey,
    model,
    targetLanguage,
    context.fullMdSha256,
  ].join(":");
  let threadId = translationThreads.get(key);
  if (!threadId) {
    threadId = await client.startThread({
      model,
      developerInstructions: TRANSLATION_DEVELOPER_INSTRUCTIONS,
      cwd: context.paperDir,
      webSearch: "disabled",
    });
    translationThreads.set(key, threadId);
  }
  const result = await client.runTurn({
    threadId,
    prompt,
    model,
    effort: normalizeEffort(getPref("paper.codexEffort") as string),
    cwd: context.paperDir,
    signal,
    onDelta: (_delta, accumulated) => onUpdate(accumulated),
  });
  return result.text;
}

async function updateTerminology(
  context: ValidatedPaperContext,
  input: string,
  translation: string,
  signal: AbortSignal,
): Promise<void> {
  const client = await getCodexClient(getPref("paper.codexPath") as string);
  const model = requiredPref("paper.codexModel");
  const threadId = await client.startThread({
    model,
    developerInstructions: TERMINOLOGY_DEVELOPER_INSTRUCTIONS,
    cwd: context.paperDir,
    webSearch: "disabled",
  });
  const result = await client.runTurn({
    threadId,
    prompt: buildTerminologyPrompt({ context, input, translation }),
    model,
    effort: normalizeEffort(getPref("paper.codexEffort") as string),
    cwd: context.paperDir,
    signal,
  });
  await persistTerminology({
    context,
    entries: parseTerminologyResult(result.text),
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
      typeof item.source !== "string" ||
      typeof item.translation !== "string" ||
      typeof item.evidence !== "string"
    ) {
      throw new Error(`Terminology entry ${index} is incomplete`);
    }
    return {
      source: item.source,
      translation: item.translation,
      evidence: item.evidence,
    };
  });
}

function requiredBackend(): TranslationBackend {
  const value = String(getPref("paper.backend") || "");
  if (
    value === "codex" ||
    value === "responses" ||
    value === "chat-completions"
  )
    return value;
  throw new Error(`Unsupported translation backend: ${value}`);
}

function requiredTemperature(): number {
  const value = Number(getPref("paper.temperature"));
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    throw new Error(
      `Invalid API temperature: ${String(getPref("paper.temperature"))}`,
    );
  }
  return value;
}

function requiredPref(key: string): string {
  const value = String(getPref(key) || "").trim();
  if (!value) throw new Error(`Required preference is empty: ${key}`);
  return value;
}
