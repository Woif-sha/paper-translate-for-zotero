import { runLegacyCodexRequest } from "../codex/legacyClient";
import { getPref } from "../utils/prefs";
import {
  CORE_KNOWLEDGE_DEVELOPER_INSTRUCTIONS,
  EXTERNAL_RESEARCH_DEVELOPER_INSTRUCTIONS,
  buildCoreKnowledgePrompt,
  buildExternalResearchPrompt,
} from "./prompts";
import {
  BackgroundSource,
  MAXIMUM_TERMINOLOGY_ENTRIES,
  MINIMUM_TERMINOLOGY_ENTRIES,
  PreparationFailureKind,
  PreparationStageId,
  PreparationStageStatus,
  PreparationRecord,
  PreparationRetryScope,
  TerminologyEntry,
  ValidatedPaperContext,
  beginPreparationAttempt,
  countTerminologyEntries,
  persistBackgroundResearch,
  persistCoreBackground,
  persistTerminology,
  readBackgroundResearchRecord,
  readCurrentPaperBackground,
  readPreparationRecord,
  setPreparationStage,
  setPreparationStages,
} from "./runtime";

type CoreKnowledge = {
  field: string;
  problem: string;
  workflow: string;
  method: string;
  evaluation: string;
  translationRisks: string[];
  openQuestions: string[];
  searchQueries: string[];
  terms: Array<
    Pick<
      TerminologyEntry,
      "observed" | "canonical" | "translation" | "category" | "definition"
    >
  >;
};

const coreJobs = new Map<string, Promise<void>>();
const externalJobs = new Map<string, Promise<void>>();
const paperTransitions = new Map<string, Promise<void>>();
const paperStopEpochs = new Map<string, number>();
const retryAttemptOwners = new Set<string>();
const knowledgeJobControllers = new Map<string, AbortController>();
const activeKnowledgeCancellations = new Map<
  string,
  Set<(message: string) => void>
>();
const MAXIMUM_CORE_TERMS = MAXIMUM_TERMINOLOGY_ENTRIES;
const MAXIMUM_TRANSLATION_RISKS = 4;
const MAXIMUM_OPEN_QUESTIONS = 3;
const MAXIMUM_SEARCH_QUERIES = 3;
const MAXIMUM_EXTERNAL_SOURCES = 3;
const CORE_MAX_OUTPUT_CHARACTERS = 16_000;
const EXTERNAL_MAX_OUTPUT_CHARACTERS = 8_000;
const CORE_MAX_RESPONSE_BYTES = 2_000_000;
const EXTERNAL_MAX_RESPONSE_BYTES = 1_000_000;
const CORE_REQUEST_HANG_LIMIT_MS = 180_000;
const EXTERNAL_REQUEST_HANG_LIMIT_MS = 60_000;
let knowledgeSessionGeneration = 0;
let knowledgeSessionActive = false;

export function beginKnowledgeOperationsSession(): void {
  knowledgeSessionGeneration += 1;
  knowledgeSessionActive = true;
}

export function endKnowledgeOperationsSession(): void {
  knowledgeSessionActive = false;
  knowledgeSessionGeneration += 1;
  cancelActiveKnowledgeOperations();
}

export async function continuePaperLearning(
  context: ValidatedPaperContext,
): Promise<void> {
  const session = currentKnowledgeSession();
  if (session === null) return;
  const paperKey = stablePaperKey(context);
  if (paperTransitions.has(paperKey)) return;
  const stopEpoch = currentPaperStopEpoch(paperKey);
  await ensureCorePaperKnowledge(context, undefined, session);
  if (
    !knowledgeSessionIsCurrent(session) ||
    paperTransitions.has(paperKey) ||
    currentPaperStopEpoch(paperKey) !== stopEpoch
  ) {
    return;
  }
  const preparation = await readPreparationRecord(context);
  if (
    paperTransitions.has(paperKey) ||
    currentPaperStopEpoch(paperKey) !== stopEpoch ||
    !coreKnowledgeIsComplete(preparation)
  ) {
    return;
  }
  await ensureExternalKnowledgeResearch(context, undefined, session);
}

export function cancelActiveKnowledgeOperations(): void {
  for (const controller of knowledgeJobControllers.values()) {
    controller.abort();
  }
  for (const cancellations of activeKnowledgeCancellations.values()) {
    for (const cancel of [...cancellations]) {
      cancel("论文知识准备已取消");
    }
  }
}

export function stopPaperLearning(
  context: ValidatedPaperContext,
): Promise<void> {
  const paperKey = stablePaperKey(context);
  return withPaperTransition(paperKey, () =>
    stopPaperLearningNow(context, paperKey),
  );
}

async function stopPaperLearningNow(
  context: ValidatedPaperContext,
  paperKey: string,
): Promise<void> {
  paperStopEpochs.set(paperKey, currentPaperStopEpoch(paperKey) + 1);
  const prefix = `${paperKey}:`;
  for (const [key, controller] of knowledgeJobControllers) {
    if (key.includes(`:${prefix}`)) controller.abort();
  }
  for (const [key, cancellations] of activeKnowledgeCancellations) {
    if (!key.startsWith(prefix)) continue;
    for (const cancel of [...cancellations]) {
      cancel("用户已停止论文知识准备");
    }
  }
  const jobs = [
    ...[...coreJobs.entries()]
      .filter(([key]) => key.includes(`:${prefix}`))
      .map(([, job]) => job),
    ...[...externalJobs.entries()]
      .filter(([key]) => key.includes(`:${prefix}`))
      .map(([, job]) => job),
  ];
  await Promise.allSettled(jobs);
  if (paperHasActiveKnowledgeJob(prefix)) return;
  await closeUserStoppedRunningStage(context);
}

export async function startPaperLearningRetry(
  context: ValidatedPaperContext,
  scope: PreparationRetryScope,
): Promise<{ attemptId: number; learning: Promise<void> }> {
  const session = currentKnowledgeSession();
  if (session === null) {
    throw new Error("Knowledge operations session is not active");
  }
  const paperKey = stablePaperKey(context);
  return withPaperTransition(paperKey, async () => {
    await stopPaperLearningNow(context, paperKey);
    assertKnowledgeSession(session);
    const preparation = await beginPreparationAttempt(context, scope);
    const stopEpoch = currentPaperStopEpoch(paperKey);
    const ownerKey = attemptOwnerKey(context, preparation.attemptId);
    retryAttemptOwners.add(ownerKey);
    const operation =
      scope === "core"
        ? continuePaperLearningAfterRetry(
            context,
            preparation.attemptId,
            stopEpoch,
            session,
          )
        : ensureExternalKnowledgeResearchNow(
            context,
            undefined,
            session,
            true,
            preparation.attemptId,
          );
    const learning = operation.finally(() => {
      retryAttemptOwners.delete(ownerKey);
    });
    return {
      attemptId: preparation.attemptId,
      learning,
    };
  });
}

export async function ensureCorePaperKnowledge(
  context: ValidatedPaperContext,
  signal?: AbortSignal,
  session = currentKnowledgeSession(),
): Promise<void> {
  return ensureCorePaperKnowledgeNow(context, signal, session, false);
}

async function ensureCorePaperKnowledgeNow(
  context: ValidatedPaperContext,
  signal: AbortSignal | undefined,
  session: number | null,
  allowPaperTransition: boolean,
  expectedAttempt?: number,
): Promise<void> {
  if (session === null || !knowledgeSessionIsCurrent(session)) return;
  if (!allowPaperTransition && paperTransitions.has(stablePaperKey(context))) {
    return;
  }
  const key = `core:${contextKey(context)}:${session}`;
  const active = coreJobs.get(key);
  if (active) return active;
  const controller = createKnowledgeJobController(signal);
  knowledgeJobControllers.set(key, controller);
  const job = decideCoreKnowledgeWork(
    context,
    session,
    controller.signal,
    expectedAttempt,
  ).finally(() => {
    if (coreJobs.get(key) === job) coreJobs.delete(key);
    if (knowledgeJobControllers.get(key) === controller) {
      knowledgeJobControllers.delete(key);
    }
  });
  coreJobs.set(key, job);
  return job;
}

export async function ensureExternalKnowledgeResearch(
  context: ValidatedPaperContext,
  signal?: AbortSignal,
  session = currentKnowledgeSession(),
): Promise<void> {
  return ensureExternalKnowledgeResearchNow(context, signal, session, false);
}

async function ensureExternalKnowledgeResearchNow(
  context: ValidatedPaperContext,
  signal: AbortSignal | undefined,
  session: number | null,
  allowPaperTransition: boolean,
  expectedAttempt?: number,
): Promise<void> {
  if (session === null || !knowledgeSessionIsCurrent(session)) return;
  if (!allowPaperTransition && paperTransitions.has(stablePaperKey(context))) {
    return;
  }
  const key = `external:${contextKey(context)}:${session}`;
  const active = externalJobs.get(key);
  if (active) return active;
  const controller = createKnowledgeJobController(signal);
  knowledgeJobControllers.set(key, controller);
  const job = decideExternalResearchWork(
    context,
    session,
    controller.signal,
    expectedAttempt,
  ).finally(() => {
    if (externalJobs.get(key) === job) externalJobs.delete(key);
    if (knowledgeJobControllers.get(key) === controller) {
      knowledgeJobControllers.delete(key);
    }
  });
  externalJobs.set(key, job);
  return job;
}

function continuePaperLearningAfterRetry(
  context: ValidatedPaperContext,
  expectedAttempt: number,
  stopEpoch: number,
  session: number,
): Promise<void> {
  const paperKey = stablePaperKey(context);
  const core = ensureCorePaperKnowledgeNow(
    context,
    undefined,
    session,
    true,
    expectedAttempt,
  );
  return (async () => {
    await core;
    if (
      !knowledgeSessionIsCurrent(session) ||
      paperTransitions.has(paperKey) ||
      currentPaperStopEpoch(paperKey) !== stopEpoch
    ) {
      return;
    }
    const preparation = await readPreparationRecord(context);
    if (
      paperTransitions.has(paperKey) ||
      currentPaperStopEpoch(paperKey) !== stopEpoch ||
      !coreKnowledgeIsComplete(preparation)
    ) {
      return;
    }
    await ensureExternalKnowledgeResearchNow(
      context,
      undefined,
      session,
      false,
      expectedAttempt,
    );
  })();
}

function withPaperTransition<T>(
  paperKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = paperTransitions.get(paperKey) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => turn);
  paperTransitions.set(paperKey, tail);
  return (async () => {
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (paperTransitions.get(paperKey) === tail) {
        paperTransitions.delete(paperKey);
      }
    }
  })();
}

async function decideCoreKnowledgeWork(
  context: ValidatedPaperContext,
  session: number,
  signal?: AbortSignal,
  expectedAttempt?: number,
): Promise<void> {
  if (!knowledgeRunIsCurrent(session, signal)) return;
  const preparation = await readPreparationRecord(context);
  if (!knowledgeRunIsCurrent(session, signal)) return;
  const attempt = preparation.attemptId;
  if (
    expectedAttempt !== undefined &&
    expectedAttempt !== preparation.attemptId
  ) {
    return;
  }
  if (retryAttemptIsUnowned(context, preparation, expectedAttempt)) {
    await closeInterruptedRetryAttempt(context, preparation, session, signal);
    return;
  }
  if (coreKnowledgeHasTerminalFailure(preparation)) {
    await closeDownstreamKnowledgeStages(
      context,
      preparation,
      session,
      attempt,
      signal,
    );
    return;
  }
  if (coreKnowledgeIsComplete(preparation)) return;
  if (
    stageStatus(preparation, "background") === "complete" &&
    stageStatus(preparation, "terminology") === "pending"
  ) {
    await stopCorePreparation(
      context,
      "terminology",
      "上一轮核心知识写入未完整结束，已停止且不会自动重试",
      session,
      attempt,
      signal,
    );
    return;
  }
  const running = preparation.stages.find(
    (stage) =>
      (stage.id === "background" || stage.id === "terminology") &&
      stage.status === "running",
  );
  if (running) {
    await stopStaleCorePreparation(
      context,
      running.id as "background" | "terminology",
      session,
      attempt,
      signal,
    );
    return;
  }
  await runCoreKnowledge(context, session, attempt, signal);
}

async function decideExternalResearchWork(
  context: ValidatedPaperContext,
  session: number,
  signal?: AbortSignal,
  expectedAttempt?: number,
): Promise<void> {
  if (!knowledgeRunIsCurrent(session, signal)) return;
  const preparation = await readPreparationRecord(context);
  const attempt = preparation.attemptId;
  if (
    expectedAttempt !== undefined &&
    expectedAttempt !== preparation.attemptId
  ) {
    return;
  }
  if (retryAttemptIsUnowned(context, preparation, expectedAttempt)) {
    await closeInterruptedRetryAttempt(context, preparation, session, signal);
    return;
  }
  const external = preparation.stages.find((stage) => stage.id === "external");
  if (
    !external ||
    ["complete", "warning", "skipped", "error"].includes(external.status) ||
    hasIntegrityIssue(preparation, "external") ||
    coreKnowledgeHasTerminalFailure(preparation)
  ) {
    return;
  }
  const background = await readCurrentPaperBackground(context);
  if (!knowledgeRunIsCurrent(session, signal)) return;
  const queries = uniqueStrings(deriveSearchQueries(background)).slice(
    0,
    MAXIMUM_SEARCH_QUERIES,
  );
  if (external.status === "running") {
    await stopStaleExternalPreparation(
      context,
      queries,
      session,
      attempt,
      signal,
    );
    return;
  }
  const existing = await readBackgroundResearchRecord(context);
  if (!knowledgeRunIsCurrent(session, signal)) return;
  if (["complete", "empty", "warning"].includes(existing.status)) return;
  await runExternalResearch(context, queries, session, attempt, signal);
}

async function runCoreKnowledge(
  context: ValidatedPaperContext,
  session: number,
  attempt: number,
  signal?: AbortSignal,
) {
  const preparation = await readPreparationRecord(context);
  if (preparation.attemptId !== attempt) return;
  const backgroundComplete =
    stageStatus(preparation, "background") === "complete";
  const terminologyComplete =
    stageStatus(preparation, "terminology") === "complete";
  let currentStage: "background" | "terminology" = backgroundComplete
    ? "terminology"
    : "background";
  let failureKind: PreparationFailureKind = "request";
  try {
    assertKnowledgeRun(session, signal);
    if (!backgroundComplete) {
      failureKind = "persistence";
      await setKnowledgeStage(context, session, attempt, signal, {
        id: "background",
        status: "running",
      });
    }
    failureKind = "request";
    assertKnowledgeRun(session, signal);
    const result = await runBoundedKnowledgeOperation({
      label: "论文核心知识准备",
      maxDurationMs: CORE_REQUEST_HANG_LIMIT_MS,
      signal,
      operationKey: `${contextKey(context)}:${attempt}`,
      operation: (requestSignal) =>
        runLegacyCodexRequest({
          apiUrl: requiredPref("paper.codexApiUrl"),
          model: requiredPref("paper.codexModel"),
          effort: String(getPref("paper.codexEffort") || ""),
          instructions: CORE_KNOWLEDGE_DEVELOPER_INSTRUCTIONS,
          prompt: buildCoreKnowledgePrompt(context),
          signal: requestSignal,
          maxOutputCharacters: CORE_MAX_OUTPUT_CHARACTERS,
          maxResponseBytes: CORE_MAX_RESPONSE_BYTES,
        }),
    });
    failureKind = "response";
    assertKnowledgeRun(session, signal);
    const parsed = parseCoreKnowledgeResult(result.text);
    const terms = validatePaperTerminology(parsed.terms, context);
    failureKind = "persistence";
    if (!backgroundComplete) {
      await persistCoreBackground({
        context,
        expectedAttempt: attempt,
        markdown: formatCoreBackground(parsed),
        assertActive: () => assertKnowledgeRun(session, signal),
      });
      await setKnowledgeStage(context, session, attempt, signal, {
        id: "background",
        status: "complete",
      });
    }
    currentStage = "terminology";
    if (!terminologyComplete) {
      await setKnowledgeStage(context, session, attempt, signal, {
        id: "terminology",
        status: "running",
      });
      await persistTerminology({
        context,
        expectedAttempt: attempt,
        entries: terms,
        assertActive: () => assertKnowledgeRun(session, signal),
      });
      failureKind = "response";
      assertMinimumTerminologyCount(
        countTerminologyEntries(context.terminology, context.markdown),
      );
      failureKind = "persistence";
      await setKnowledgeStage(context, session, attempt, signal, {
        id: "terminology",
        status: "complete",
      });
    }
  } catch (error) {
    if (!knowledgeSessionIsCurrent(session)) throw error;
    const detail = conciseError(error);
    const kind = classifyKnowledgeFailure(error, failureKind, signal);
    try {
      await stopCorePreparation(
        context,
        currentStage,
        detail,
        session,
        attempt,
        signal,
        kind,
      );
    } catch (stopError) {
      throw new AggregateError(
        [error, stopError],
        "Core knowledge preparation and its error-state write both failed",
      );
    }
    throw error;
  }
}

async function runExternalResearch(
  context: ValidatedPaperContext,
  queries: string[],
  session: number,
  attempt: number,
  signal?: AbortSignal,
) {
  assertKnowledgeRun(session, signal);
  try {
    await setKnowledgeStage(context, session, attempt, signal, {
      id: "external",
      status: "running",
    });
  } catch (error) {
    if (!knowledgeSessionIsCurrent(session)) throw error;
    if (signal?.aborted) {
      await markExternalStopped(context, session, attempt, error);
      throw error;
    }
    await markExternalPersistenceFailure(
      context,
      session,
      attempt,
      signal,
      error,
    );
    throw error;
  }
  assertKnowledgeRun(session, signal);
  if (!queries.length) {
    try {
      assertKnowledgeRun(session, signal);
      await persistBackgroundResearch({
        context,
        expectedAttempt: attempt,
        summary: "",
        queries: [],
        sources: [],
        status: "empty",
        assertActive: () => assertKnowledgeRun(session, signal),
      });
      await setKnowledgeStage(context, session, attempt, signal, {
        id: "external",
        status: "skipped",
        detail: "论文分析未提出外部检索问题",
      });
    } catch (error) {
      if (!knowledgeSessionIsCurrent(session)) throw error;
      if (signal?.aborted) {
        await markExternalStopped(context, session, attempt, error);
        throw error;
      }
      await markExternalPersistenceFailure(
        context,
        session,
        attempt,
        signal,
        error,
      );
      throw error;
    }
    return;
  }
  let parsed: ReturnType<typeof parseResearchResult>;
  try {
    const result = await runBoundedKnowledgeOperation({
      label: "论文外部知识补充",
      maxDurationMs: EXTERNAL_REQUEST_HANG_LIMIT_MS,
      signal,
      operationKey: `${contextKey(context)}:${attempt}`,
      operation: (requestSignal) =>
        runLegacyCodexRequest({
          apiUrl: requiredPref("paper.codexApiUrl"),
          model: requiredPref("paper.codexModel"),
          effort: String(getPref("paper.codexEffort") || ""),
          instructions: EXTERNAL_RESEARCH_DEVELOPER_INSTRUCTIONS,
          prompt: buildExternalResearchPrompt({ context, queries }),
          signal: requestSignal,
          webSearch: true,
          requireWebSearch: false,
          maxOutputCharacters: EXTERNAL_MAX_OUTPUT_CHARACTERS,
          maxResponseBytes: EXTERNAL_MAX_RESPONSE_BYTES,
          maxObservedWebSearchCalls: MAXIMUM_SEARCH_QUERIES,
        }),
    });
    assertKnowledgeRun(session, signal);
    parsed = parseResearchResult(result.text);
    if (parsed.sources.length && !result.usedWebSearch) {
      throw new Error(
        "Codex returned external sources without a web search event",
      );
    }
    const citedUrls = new Set(result.citedUrls.map(normalizeUrl));
    const uncited = parsed.sources.find(
      (source) => !citedUrls.has(normalizeUrl(source.url)),
    );
    if (uncited) {
      throw new Error(
        `Codex returned an external source without a matching URL citation: ${uncited.title}`,
      );
    }
  } catch (error) {
    if (!knowledgeSessionIsCurrent(session)) throw error;
    const failureKind = classifyKnowledgeFailure(error, "request", signal);
    if (failureKind === "user-stopped") {
      await setKnowledgeStage(context, session, attempt, undefined, {
        id: "external",
        status: "error",
        detail: conciseError(error),
        failureKind,
      });
      throw error;
    }
    try {
      await persistExternalWarning(
        context,
        queries,
        error,
        session,
        attempt,
        signal,
        failureKind,
      );
    } catch (warningError) {
      if (!knowledgeSessionIsCurrent(session)) throw warningError;
      if (signal?.aborted) {
        await markExternalStopped(context, session, attempt, warningError);
        throw warningError;
      }
      try {
        await markExternalPersistenceFailure(
          context,
          session,
          attempt,
          signal,
          warningError,
        );
      } catch (stageError) {
        throw new AggregateError(
          [error, warningError, stageError],
          "External research, warning persistence, and error-state write all failed",
        );
      }
      throw new AggregateError(
        [error, warningError],
        "External research failed and its warning record could not be written",
      );
    }
    return;
  }
  try {
    await persistBackgroundResearch({
      context,
      expectedAttempt: attempt,
      summary: parsed.summary,
      queries,
      sources: parsed.sources,
      assertActive: () => assertKnowledgeRun(session, signal),
    });
    await setKnowledgeStage(context, session, attempt, signal, {
      id: "external",
      status: parsed.sources.length ? "complete" : "warning",
      detail: parsed.sources.length ? undefined : "未找到可用外部来源",
      failureKind: parsed.sources.length ? undefined : "request",
    });
  } catch (error) {
    if (!knowledgeSessionIsCurrent(session)) throw error;
    if (signal?.aborted) {
      await markExternalStopped(context, session, attempt, error);
      throw error;
    }
    await markExternalPersistenceFailure(
      context,
      session,
      attempt,
      signal,
      error,
    );
    throw error;
  }
}

async function markExternalStopped(
  context: ValidatedPaperContext,
  session: number,
  attempt: number,
  error: unknown,
): Promise<void> {
  await setKnowledgeStage(context, session, attempt, undefined, {
    id: "external",
    status: "error",
    detail: conciseError(error),
    failureKind: "user-stopped",
  });
}

async function markExternalPersistenceFailure(
  context: ValidatedPaperContext,
  session: number,
  attempt: number,
  signal: AbortSignal | undefined,
  error: unknown,
): Promise<void> {
  const detail = conciseError(error);
  try {
    await setKnowledgeStage(context, session, attempt, signal, {
      id: "external",
      status: "error",
      detail: `外部知识文件写入失败：${detail}`,
      failureKind: "persistence",
    });
  } catch (stageError) {
    throw new AggregateError(
      [error, stageError],
      "External research persistence and its error-state write both failed",
    );
  }
}

async function persistExternalWarning(
  context: ValidatedPaperContext,
  queries: string[],
  error: unknown,
  session: number,
  attempt: number,
  signal: AbortSignal | undefined,
  failureKind: PreparationFailureKind,
): Promise<void> {
  const detail = conciseError(error);
  await persistBackgroundResearch({
    context,
    expectedAttempt: attempt,
    summary: "",
    queries,
    sources: [],
    failures: [{ provider: "web-search", message: detail }],
    status: "warning",
    assertActive: () => assertKnowledgeRun(session, signal),
  });
  await setKnowledgeStage(context, session, attempt, signal, {
    id: "external",
    status: "warning",
    detail: "1 个来源受限",
    failureKind,
  });
}

async function stopStaleExternalPreparation(
  context: ValidatedPaperContext,
  queries: string[],
  session: number,
  attempt: number,
  signal?: AbortSignal,
): Promise<void> {
  const detail = "上一轮外部补充未正常结束，已停止且不会自动重试";
  try {
    await persistBackgroundResearch({
      context,
      expectedAttempt: attempt,
      summary: "",
      queries,
      sources: [],
      failures: [{ provider: "web-search", message: detail }],
      status: "warning",
      assertActive: () => assertKnowledgeRun(session, signal),
    });
    await setKnowledgeStage(context, session, attempt, signal, {
      id: "external",
      status: "warning",
      detail,
      failureKind: "legacy-unclassified",
    });
  } catch (error) {
    if (!knowledgeSessionIsCurrent(session)) throw error;
    await markExternalPersistenceFailure(
      context,
      session,
      attempt,
      signal,
      error,
    );
    throw error;
  }
}

export function parseCoreKnowledgeResult(value: string): CoreKnowledge {
  const parsed = parseObject(value, "core knowledge") as Record<
    string,
    unknown
  >;
  const stringKeys = [
    "field",
    "problem",
    "workflow",
    "method",
    "evaluation",
  ] as const;
  for (const key of stringKeys)
    if (typeof parsed[key] !== "string" || !parsed[key].trim())
      throw new Error(`Core knowledge is missing ${key}`);
  for (const key of [
    "translationRisks",
    "openQuestions",
    "searchQueries",
    "terms",
  ] as const) {
    if (!Array.isArray(parsed[key]))
      throw new Error(`Core knowledge is missing ${key}`);
  }
  const terms = (parsed.terms as unknown[])
    .slice(0, MAXIMUM_CORE_TERMS)
    .map((term, index) => {
      if (!term || typeof term !== "object")
        throw new Error(`Core terminology ${index} is invalid`);
      const item = term as Record<string, unknown>;
      for (const key of [
        "observed",
        "canonical",
        "translation",
        "category",
        "definition",
      ] as const) {
        if (typeof item[key] !== "string" || !item[key].trim())
          throw new Error(`Core terminology ${index} is missing ${key}`);
      }
      const normalized = Object.fromEntries(
        ["observed", "canonical", "translation", "category", "definition"].map(
          (key) => [key, String(item[key]).trim()],
        ),
      ) as CoreKnowledge["terms"][number];
      if (
        normalized.observed.length > 160 ||
        normalized.canonical.length > 160 ||
        normalized.translation.length > 160 ||
        normalized.category.length > 80 ||
        normalized.definition.length > 240
      ) {
        throw new Error(`Core terminology ${index} exceeds its size limit`);
      }
      return normalized;
    });
  return {
    field: boundedText(parsed.field as string),
    problem: boundedText(parsed.problem as string),
    workflow: boundedText(parsed.workflow as string),
    method: boundedText(parsed.method as string),
    evaluation: boundedText(parsed.evaluation as string),
    translationRisks: validateStringArray(
      parsed.translationRisks,
      "translationRisks",
    ).slice(0, MAXIMUM_TRANSLATION_RISKS),
    openQuestions: validateStringArray(
      parsed.openQuestions,
      "openQuestions",
    ).slice(0, MAXIMUM_OPEN_QUESTIONS),
    searchQueries: validateStringArray(
      parsed.searchQueries,
      "searchQueries",
    ).slice(0, MAXIMUM_SEARCH_QUERIES),
    terms,
  };
}

export function validatePaperTerminology(
  terms: CoreKnowledge["terms"],
  context: ValidatedPaperContext,
): TerminologyEntry[] {
  const seen = new Set<string>();
  const validated: TerminologyEntry[] = [];
  for (const term of terms) {
    const offset = context.markdown.indexOf(term.observed);
    const key = term.canonical.trim().toLocaleLowerCase();
    if (offset < 0 || !key || seen.has(key)) continue;
    const chunk = context.index.chunks.find(
      (item) => offset >= item.charStart && offset < item.charEnd,
    );
    validated.push({
      ...term,
      evidence: `${chunk?.heading || "Paper"}; chars ${offset}-${offset + term.observed.length}`,
      sourceLevel: "paper",
      confidence: "high",
    });
    seen.add(key);
    if (validated.length === MAXIMUM_CORE_TERMS) break;
  }
  return validated;
}

export function parseResearchResult(value: string): {
  summary: string;
  sources: BackgroundSource[];
} {
  const parsed = parseObject(value, "background research") as Record<
    string,
    unknown
  >;
  if (typeof parsed.summary !== "string" || !Array.isArray(parsed.sources))
    throw new Error("Background research is missing summary or sources");
  const sources = parsed.sources
    .slice(0, MAXIMUM_EXTERNAL_SOURCES)
    .map((source, index) => {
      if (!source || typeof source !== "object")
        throw new Error(`Background source ${index} must be an object`);
      const item = source as Record<string, unknown>;
      for (const key of [
        "title",
        "url",
        "snippet",
        "sourceLevel",
        "purpose",
      ] as const) {
        if (typeof item[key] !== "string" || !item[key].trim())
          throw new Error(`Background source ${index} is missing ${key}`);
      }
      if (
        !["official", "academic", "community"].includes(
          item.sourceLevel as string,
        )
      )
        throw new Error(`Background source ${index} has invalid sourceLevel`);
      let url: URL;
      try {
        url = new URL(item.url as string);
      } catch {
        throw new Error(`Background source ${index} has an invalid URL`);
      }
      if (url.protocol !== "https:") {
        throw new Error(`Background source ${index} must use HTTPS`);
      }
      if (url.href.length > 2_048) {
        throw new Error(`Background source ${index} URL is too long`);
      }
      return {
        title: boundedText(item.title as string, 200),
        url: url.href,
        snippet: boundedText(item.snippet as string, 500),
        sourceLevel: item.sourceLevel as BackgroundSource["sourceLevel"],
        purpose: boundedText(item.purpose as string, 200),
      };
    });
  if (sources.length && !parsed.summary.trim())
    throw new Error("Background research with sources requires a summary");
  if (!sources.length && parsed.summary.trim()) {
    throw new Error("Background research without sources must have no summary");
  }
  return { summary: boundedText(parsed.summary, 800), sources };
}

export function assertMinimumCoreKnowledge(terms: TerminologyEntry[]): void {
  assertMinimumTerminologyCount(terms.length);
}

function assertMinimumTerminologyCount(count: number): void {
  if (count < MINIMUM_TERMINOLOGY_ENTRIES) {
    throw new Error(
      `Core knowledge requires at least ${MINIMUM_TERMINOLOGY_ENTRIES} distinct paper-evidenced terms; received ${count}`,
    );
  }
}

export async function runBoundedKnowledgeOperation<T>(params: {
  label: string;
  maxDurationMs: number;
  signal?: AbortSignal;
  operationKey?: string;
  operation(signal: AbortSignal): Promise<T>;
}): Promise<T> {
  if (!Number.isFinite(params.maxDurationMs) || params.maxDurationMs <= 0) {
    throw new Error("Knowledge operation duration must be a positive number");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectOuter: ((reason: Error) => void) | undefined;
  const cancel = (message: string) => {
    controller.abort();
    rejectOuter?.(new Error(message));
  };
  const operationKey = params.operationKey ?? "global";
  const cancellations =
    activeKnowledgeCancellations.get(operationKey) ??
    new Set<(message: string) => void>();
  cancellations.add(cancel);
  activeKnowledgeCancellations.set(operationKey, cancellations);
  const onParentAbort = () => cancel(`${params.label}已取消`);
  if (params.signal?.aborted) onParentAbort();
  params.signal?.addEventListener("abort", onParentAbort, { once: true });
  try {
    return await new Promise<T>((resolve, reject) => {
      rejectOuter = reject;
      if (params.signal?.aborted) {
        onParentAbort();
        return;
      }
      timer = setTimeout(
        () =>
          cancel(
            `${params.label}在 ${Math.ceil(params.maxDurationMs / 1_000)} 秒内未结束，已取消`,
          ),
        params.maxDurationMs,
      );
      void params.operation(controller.signal).then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    params.signal?.removeEventListener("abort", onParentAbort);
    cancellations.delete(cancel);
    if (!cancellations.size) {
      activeKnowledgeCancellations.delete(operationKey);
    }
  }
}

function coreKnowledgeIsComplete(record: PreparationRecord): boolean {
  return (
    !hasIntegrityIssue(record, "background") &&
    !hasIntegrityIssue(record, "terminology") &&
    stageStatus(record, "background") === "complete" &&
    stageStatus(record, "terminology") === "complete"
  );
}

function paperHasActiveKnowledgeJob(prefix: string): boolean {
  return (
    [...knowledgeJobControllers.keys()].some((key) =>
      key.includes(`:${prefix}`),
    ) ||
    [...coreJobs.keys()].some((key) => key.includes(`:${prefix}`)) ||
    [...externalJobs.keys()].some((key) => key.includes(`:${prefix}`))
  );
}

async function closeUserStoppedRunningStage(
  context: ValidatedPaperContext,
): Promise<void> {
  const preparation = await readPreparationRecord(context);
  const stoppedStage =
    preparation.stages.find(
      (stage) =>
        ["background", "terminology", "external"].includes(stage.id) &&
        stage.status === "running",
    ) ??
    preparation.stages.find(
      (stage) =>
        ["background", "terminology", "external"].includes(stage.id) &&
        stage.status === "pending",
    );
  if (!stoppedStage) return;
  const updates: Array<{
    id: PreparationStageId;
    status: PreparationStageStatus;
    detail?: string;
    failureKind?: PreparationFailureKind;
  }> = [
    {
      id: stoppedStage.id,
      status: "error",
      detail: "用户已停止论文知识准备",
      failureKind: "user-stopped",
    },
  ];
  if (stoppedStage.id === "background") {
    updates.push(
      {
        id: "terminology",
        status: "skipped",
        detail: "论文背景阶段未完成",
      },
      {
        id: "external",
        status: "skipped",
        detail: "核心知识阶段未完成",
      },
    );
  } else if (stoppedStage.id === "terminology") {
    updates.push({
      id: "external",
      status: "skipped",
      detail: "核心知识阶段未完成",
    });
  }
  await setPreparationStages(context, updates, preparation.attemptId);
}

function currentPaperStopEpoch(paperKey: string): number {
  return paperStopEpochs.get(paperKey) ?? 0;
}

function coreKnowledgeHasTerminalFailure(record: PreparationRecord): boolean {
  return (["background", "terminology"] as const).some(
    (id) =>
      hasIntegrityIssue(record, id) ||
      ["warning", "error", "skipped"].includes(stageStatus(record, id)),
  );
}

function hasIntegrityIssue(
  record: PreparationRecord,
  stage: "background" | "terminology" | "external",
): boolean {
  return Boolean(
    record.integrityIssues?.some((issue) => issue.stage === stage),
  );
}

async function closeDownstreamKnowledgeStages(
  context: ValidatedPaperContext,
  preparation: PreparationRecord,
  session: number,
  attempt: number,
  signal?: AbortSignal,
): Promise<void> {
  const backgroundStopped =
    hasIntegrityIssue(preparation, "background") ||
    ["warning", "error", "skipped"].includes(
      stageStatus(preparation, "background"),
    );
  const terminologyStopped =
    hasIntegrityIssue(preparation, "terminology") ||
    ["warning", "error", "skipped"].includes(
      stageStatus(preparation, "terminology"),
    );
  const updates = backgroundStopped
    ? ([
        {
          id: "terminology",
          status: "skipped",
          detail: "论文背景阶段已停止",
        },
        {
          id: "external",
          status: "skipped",
          detail: "论文背景阶段已停止",
        },
      ] as const)
    : terminologyStopped
      ? ([
          {
            id: "external",
            status: "skipped",
            detail: "核心术语阶段已停止",
          },
        ] as const)
      : [];
  if (!updates.length) return;
  await setPreparationStages(context, [...updates], attempt, () =>
    assertKnowledgeRun(session, signal),
  );
}

function stageStatus(record: PreparationRecord, id: string): string {
  return record.stages.find((stage) => stage.id === id)?.status || "pending";
}

function retryAttemptIsUnowned(
  context: ValidatedPaperContext,
  preparation: PreparationRecord,
  expectedAttempt?: number,
): boolean {
  if (preparation.attemptTrigger === "automatic") return false;
  if (expectedAttempt === preparation.attemptId) return false;
  return !retryAttemptOwners.has(
    attemptOwnerKey(context, preparation.attemptId),
  );
}

async function closeInterruptedRetryAttempt(
  context: ValidatedPaperContext,
  preparation: PreparationRecord,
  session: number,
  signal?: AbortSignal,
): Promise<void> {
  const attempt = preparation.attemptId;
  const detail = "上一轮人工重试在新任务接管前中断，已停止且不会自动重试";
  const unfinishedCore = (["background", "terminology"] as const).find(
    (id) => stageStatus(preparation, id) !== "complete",
  );
  if (unfinishedCore) {
    await stopCorePreparation(
      context,
      unfinishedCore,
      detail,
      session,
      attempt,
      signal,
      "interrupted",
    );
    return;
  }
  if (["pending", "running"].includes(stageStatus(preparation, "external"))) {
    await setKnowledgeStage(context, session, attempt, signal, {
      id: "external",
      status: "warning",
      detail,
      failureKind: "interrupted",
    });
  }
}

async function stopStaleCorePreparation(
  context: ValidatedPaperContext,
  stage: "background" | "terminology",
  session: number,
  attempt: number,
  signal?: AbortSignal,
): Promise<void> {
  await stopCorePreparation(
    context,
    stage,
    "上一轮知识准备未正常结束，已停止且不会自动重试",
    session,
    attempt,
    signal,
    "legacy-unclassified",
  );
}

async function stopCorePreparation(
  context: ValidatedPaperContext,
  stage: "background" | "terminology",
  detail: string,
  session: number,
  attempt: number,
  signal: AbortSignal | undefined,
  failureKind: PreparationFailureKind = "legacy-unclassified",
): Promise<void> {
  await setPreparationStages(
    context,
    [
      { id: stage, status: "error", detail, failureKind },
      ...(stage === "background"
        ? ([
            {
              id: "terminology",
              status: "skipped",
              detail: "论文背景阶段未完成",
            },
          ] as const)
        : []),
      {
        id: "external",
        status: "skipped",
        detail: "核心知识阶段未完成",
      },
    ],
    attempt,
    () =>
      failureKind === "user-stopped"
        ? assertKnowledgeSession(session)
        : assertKnowledgeRun(session, signal),
  );
}

function setKnowledgeStage(
  context: ValidatedPaperContext,
  session: number,
  attempt: number,
  signal: AbortSignal | undefined,
  update: {
    id: PreparationStageId;
    status: PreparationStageStatus;
    detail?: string;
    failureKind?: PreparationFailureKind;
  },
): Promise<PreparationRecord> {
  return setPreparationStage({
    context,
    expectedAttempt: attempt,
    ...update,
    assertActive: () => assertKnowledgeRun(session, signal),
  });
}

function formatCoreBackground(value: CoreKnowledge): string {
  const list = (items: string[]) =>
    items.length ? items.map((item) => `- ${item}`).join("\n") : "- 无";
  return [
    "## 论文依据",
    "",
    "### 所属领域",
    "",
    value.field,
    "",
    "### 研究问题",
    "",
    value.problem,
    "",
    "### 工作流",
    "",
    value.workflow,
    "",
    "### 方法组件",
    "",
    value.method,
    "",
    "### 实验与评价语境",
    "",
    value.evaluation,
    "",
    "### 翻译风险",
    "",
    list(value.translationRisks),
    "",
    "### 待补知识",
    "",
    list(value.openQuestions),
    "",
    "### 外部检索问题",
    "",
    list(value.searchQueries),
    "",
  ].join("\n");
}

function deriveSearchQueries(background: string): string[] {
  const section =
    background.split("### 外部检索问题")[1]?.split(/^### |^## /m)[0] ?? "";
  return section
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter((line) => Boolean(line) && line !== "无");
}

function currentKnowledgeSession(): number | null {
  return knowledgeSessionActive ? knowledgeSessionGeneration : null;
}

function createKnowledgeJobController(
  parentSignal?: AbortSignal,
): AbortController {
  const controller = new AbortController();
  if (parentSignal?.aborted) {
    controller.abort();
  } else {
    parentSignal?.addEventListener("abort", () => controller.abort(), {
      once: true,
    });
  }
  return controller;
}

function knowledgeSessionIsCurrent(session: number): boolean {
  return knowledgeSessionActive && session === knowledgeSessionGeneration;
}

function knowledgeRunIsCurrent(session: number, signal?: AbortSignal): boolean {
  return knowledgeSessionIsCurrent(session) && !signal?.aborted;
}

function assertKnowledgeSession(session: number): void {
  if (!knowledgeSessionIsCurrent(session)) {
    throw new Error("Paper knowledge preparation session is no longer active");
  }
}

function assertKnowledgeRun(session: number, signal?: AbortSignal): void {
  assertKnowledgeSession(session);
  if (signal?.aborted) {
    throw new Error("用户已停止论文知识准备");
  }
}

function classifyKnowledgeFailure(
  error: unknown,
  phase: PreparationFailureKind,
  signal?: AbortSignal,
): PreparationFailureKind {
  const message = error instanceof Error ? error.message : String(error);
  if (signal?.aborted || /用户已停止/u.test(message)) return "user-stopped";
  if (/秒内未结束/u.test(message)) return "timeout";
  return phase;
}

function normalizeUrl(value: string): string {
  return new URL(value).href;
}

function parseObject(value: string, label: string): object {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("result is not an object");
    return parsed;
  } catch (error) {
    throw new Error(`Codex ${label} returned invalid JSON: ${String(error)}`);
  }
}

function validateStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`${label} must be a string array`);
  return uniqueStrings(value.map((item) => boundedText(item)).filter(Boolean));
}

function boundedText(value: string, maxChars = 180): string {
  return value.trim().replace(/\s+/g, " ").slice(0, maxChars);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function contextKey(context: ValidatedPaperContext): string {
  return `${stablePaperKey(context)}:${context.fullMdSha256}`;
}

function stablePaperKey(context: ValidatedPaperContext): string {
  return `${context.identity.libraryID}:${context.identity.parentItemKey}`;
}

function attemptOwnerKey(
  context: ValidatedPaperContext,
  attempt: number,
): string {
  return `${contextKey(context)}:${attempt}`;
}

function conciseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/\S+/g, "[URL omitted]").slice(0, 240);
}

function requiredPref(key: string): string {
  const value = String(getPref(key) || "").trim();
  if (!value) throw new Error(`Required preference is empty: ${key}`);
  return value;
}
