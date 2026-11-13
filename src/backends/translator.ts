import {
  MineruMarkdownUnavailableError,
  preparePaperContext,
  readPreparationRecord,
  type ValidatedPaperContext,
} from "../context/runtime";
import { continuePaperLearning } from "../context/research";
import {
  TRANSLATION_DEVELOPER_INSTRUCTIONS,
  buildStandaloneTranslationPrompt,
  buildTranslationPrompt,
} from "../context/prompts";
import {
  getActiveModelSnapshot,
  runModelRequest,
  type RuntimeModel,
} from "../models/runtime";
type PaperLearningScheduleDependencies = {
  readAttemptId(context: ValidatedPaperContext): Promise<number>;
  continueLearning(context: ValidatedPaperContext): Promise<void>;
  monitor?(
    context: ValidatedPaperContext,
    learning: Promise<void>,
    attemptId: number,
  ): void;
  report(error: unknown): void;
};

export type PaperTranslationObserver = {
  contextPrepared(context: ValidatedPaperContext): void;
  learningStarted(
    context: ValidatedPaperContext,
    learning: Promise<void>,
    attemptId: number,
  ): void;
};

const paperLearningDependencies: PaperLearningScheduleDependencies = {
  async readAttemptId(context) {
    return (await readPreparationRecord(context)).attemptId;
  },
  continueLearning: continuePaperLearning,
  report(error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  },
};

type TranslationRequestParams = {
  attachmentItemID: number;
  sourceLanguage: string;
  targetLanguage: string;
  input: string;
};

type TranslationRequestDependencies = {
  prepareContext: typeof preparePaperContext;
};

type ResolvedTranslationRequest = {
  input: string;
  prompt: string;
  context?: ValidatedPaperContext;
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

export async function translateWithPaperContext(
  params: {
    attachmentItemID: number;
    sourceLanguage: string;
    targetLanguage: string;
    input: string;
    onUpdate(text: string): void;
  },
  observer?: PaperTranslationObserver,
): Promise<string> {
  activeTranslation?.controller.abort();
  const controller = new AbortController();
  activeTranslation = {
    attachmentItemID: params.attachmentItemID,
    controller,
  };
  const model = getActiveModelSnapshot();
  try {
    const request = await resolveTranslationRequest(params);
    if (request.context) observer?.contextPrepared(request.context);
    const translation = await translateWithModel(
      request.prompt,
      request.input,
      model,
      controller.signal,
      params.onUpdate,
    );
    if (request.context) {
      schedulePaperLearningAfterTranslation(request.context, {
        ...paperLearningDependencies,
        monitor: observer?.learningStarted,
      });
    }
    return translation;
  } finally {
    if (activeTranslation?.controller === controller)
      activeTranslation = undefined;
  }
}

export async function resolveTranslationRequest(
  params: TranslationRequestParams,
  dependencies: TranslationRequestDependencies = {
    prepareContext: preparePaperContext,
  },
): Promise<ResolvedTranslationRequest> {
  let context: ValidatedPaperContext;
  try {
    context = await dependencies.prepareContext(
      params.attachmentItemID,
      params.input,
    );
  } catch (error) {
    if (!(error instanceof MineruMarkdownUnavailableError)) throw error;
    return {
      input: params.input,
      prompt: buildStandaloneTranslationPrompt(params),
    };
  }

  const input = context.alignedQuery || params.input;
  return {
    context,
    input,
    prompt: buildTranslationPrompt({
      context,
      sourceLanguage: params.sourceLanguage,
      targetLanguage: params.targetLanguage,
      input,
    }),
  };
}

export function schedulePaperLearningAfterTranslation(
  context: ValidatedPaperContext,
  dependencies: PaperLearningScheduleDependencies = paperLearningDependencies,
): void {
  void Promise.resolve()
    .then(async () => {
      const attemptId = await dependencies.readAttemptId(context);
      const learning = dependencies.continueLearning(context);
      if (dependencies.monitor) {
        dependencies.monitor(context, learning, attemptId);
      } else {
        void learning.catch(dependencies.report);
      }
    })
    .catch((error) => dependencies.report(error));
}

async function translateWithModel(
  prompt: string,
  source: string,
  model: RuntimeModel,
  signal: AbortSignal,
  onUpdate: (text: string) => void,
): Promise<string> {
  const result = await runModelRequest(
    {
      instructions: TRANSLATION_DEVELOPER_INSTRUCTIONS,
      prompt,
      signal,
      maxOutputCharacters: 64_000,
      maxResponseBytes: 4_000_000,
      onDelta: (_delta, accumulated) =>
        onUpdate(formatTranslationLayout(source, accumulated)),
    },
    model,
  );
  return formatTranslationLayout(source, result.text);
}

export function formatTranslationLayout(
  source: string,
  translation: string,
): string {
  translation = restoreNumericScriptDirections(source, translation);
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

function restoreNumericScriptDirections(
  source: string,
  translation: string,
): string {
  const superscripts = new Set<string>();
  const otherNumbers = new Set(
    source
      .replace(/<sup>(\d+)<\/sup>/gu, (_match, digits: string) => {
        superscripts.add(digits);
        return "";
      })
      .replace(/[₀-₉]+/gu, subscriptDigits)
      .match(/\d+/gu) ?? [],
  );
  // A number used elsewhere in the source cannot identify a citation by itself.
  const isSourceSuperscript = (digits: string) =>
    superscripts.has(digits) && !otherNumbers.has(digits);
  return translation
    .replace(/~(\d+)~/gu, (value, digits: string) =>
      isSourceSuperscript(digits) ? `^${digits}^` : value,
    )
    .replace(/<sub>(\d+)<\/sub>/gu, (value, digits: string) =>
      isSourceSuperscript(digits) ? `^${digits}^` : value,
    )
    .replace(/[₀-₉]+/gu, (value) => {
      const digits = subscriptDigits(value);
      return isSourceSuperscript(digits) ? `^${digits}^` : value;
    });
}

function subscriptDigits(value: string): string {
  return Array.from(value, (character) =>
    String(character.charCodeAt(0) - 0x2080),
  ).join("");
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
