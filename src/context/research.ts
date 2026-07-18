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
  PreparationStageId,
  PreparationStageStatus,
  PreparationRecord,
  TerminologyEntry,
  ValidatedPaperContext,
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
const activeKnowledgeCancellations = new Set<(message: string) => void>();
const MAXIMUM_CORE_TERMS = MAXIMUM_TERMINOLOGY_ENTRIES;
const MAXIMUM_TRANSLATION_RISKS = 4;
const MAXIMUM_OPEN_QUESTIONS = 3;
const MAXIMUM_SEARCH_QUERIES = 3;
const MAXIMUM_EXTERNAL_SOURCES = 3;
const CORE_MAX_OUTPUT_TOKENS = 4_096;
const EXTERNAL_MAX_OUTPUT_TOKENS = 2_048;
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
  await ensureCorePaperKnowledge(context, undefined, session);
  if (!knowledgeSessionIsCurrent(session)) return;
  const preparation = await readPreparationRecord(context);
  if (!coreKnowledgeIsComplete(preparation)) return;
  await ensureExternalKnowledgeResearch(context, undefined, session);
}

export function cancelActiveKnowledgeOperations(): void {
  for (const cancel of [...activeKnowledgeCancellations]) {
    cancel("论文知识准备已取消");
  }
}

export async function ensureCorePaperKnowledge(
  context: ValidatedPaperContext,
  signal?: AbortSignal,
  session = currentKnowledgeSession(),
): Promise<void> {
  if (session === null || !knowledgeSessionIsCurrent(session)) return;
  const key = `${contextKey(context)}:${session}`;
  const active = coreJobs.get(key);
  if (active) return active;
  const job = decideCoreKnowledgeWork(context, session, signal).finally(() => {
    if (coreJobs.get(key) === job) coreJobs.delete(key);
  });
  coreJobs.set(key, job);
  return job;
}

export async function ensureExternalKnowledgeResearch(
  context: ValidatedPaperContext,
  signal?: AbortSignal,
  session = currentKnowledgeSession(),
): Promise<void> {
  if (session === null || !knowledgeSessionIsCurrent(session)) return;
  const key = `${contextKey(context)}:${session}`;
  const active = externalJobs.get(key);
  if (active) return active;
  const job = decideExternalResearchWork(context, session, signal).finally(
    () => {
      if (externalJobs.get(key) === job) externalJobs.delete(key);
    },
  );
  externalJobs.set(key, job);
  return job;
}

async function decideCoreKnowledgeWork(
  context: ValidatedPaperContext,
  session: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!knowledgeSessionIsCurrent(session)) return;
  const preparation = await readPreparationRecord(context);
  if (!knowledgeSessionIsCurrent(session)) return;
  if (coreKnowledgeHasTerminalFailure(preparation)) {
    await closeDownstreamKnowledgeStages(context, preparation, session);
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
    );
    return;
  }
  await runCoreKnowledge(context, session, signal);
}

async function decideExternalResearchWork(
  context: ValidatedPaperContext,
  session: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!knowledgeSessionIsCurrent(session)) return;
  const preparation = await readPreparationRecord(context);
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
  if (!knowledgeSessionIsCurrent(session)) return;
  const queries = uniqueStrings(deriveSearchQueries(background)).slice(
    0,
    MAXIMUM_SEARCH_QUERIES,
  );
  if (external.status === "running") {
    await stopStaleExternalPreparation(context, queries, session);
    return;
  }
  const existing = await readBackgroundResearchRecord(context);
  if (!knowledgeSessionIsCurrent(session)) return;
  if (["complete", "empty", "warning"].includes(existing.status)) return;
  await runExternalResearch(context, queries, session, signal);
}

async function runCoreKnowledge(
  context: ValidatedPaperContext,
  session: number,
  signal?: AbortSignal,
) {
  const preparation = await readPreparationRecord(context);
  const backgroundComplete =
    stageStatus(preparation, "background") === "complete";
  const terminologyComplete =
    stageStatus(preparation, "terminology") === "complete";
  let currentStage: "background" | "terminology" = backgroundComplete
    ? "terminology"
    : "background";
  try {
    assertKnowledgeSession(session);
    if (!backgroundComplete) {
      await setKnowledgeStage(context, session, {
        id: "background",
        status: "running",
      });
    }
    assertKnowledgeSession(session);
    const result = await runBoundedKnowledgeOperation({
      label: "论文核心知识准备",
      maxDurationMs: CORE_REQUEST_HANG_LIMIT_MS,
      signal,
      operation: (requestSignal) =>
        runLegacyCodexRequest({
          apiUrl: requiredPref("paper.codexApiUrl"),
          model: requiredPref("paper.codexModel"),
          effort: String(getPref("paper.codexEffort") || ""),
          instructions: CORE_KNOWLEDGE_DEVELOPER_INSTRUCTIONS,
          prompt: buildCoreKnowledgePrompt(context),
          signal: requestSignal,
          maxOutputTokens: CORE_MAX_OUTPUT_TOKENS,
        }),
    });
    assertKnowledgeSession(session);
    const parsed = parseCoreKnowledgeResult(result.text);
    const terms = validatePaperTerminology(parsed.terms, context);
    if (!backgroundComplete) {
      await persistCoreBackground({
        context,
        markdown: formatCoreBackground(parsed),
        assertActive: () => assertKnowledgeSession(session),
      });
      await setKnowledgeStage(context, session, {
        id: "background",
        status: "complete",
      });
    }
    currentStage = "terminology";
    if (!terminologyComplete) {
      await setKnowledgeStage(context, session, {
        id: "terminology",
        status: "running",
      });
      await persistTerminology({
        context,
        entries: terms,
        assertActive: () => assertKnowledgeSession(session),
      });
      assertMinimumTerminologyCount(
        countTerminologyEntries(context.terminology, context.markdown),
      );
      await setKnowledgeStage(context, session, {
        id: "terminology",
        status: "complete",
      });
    }
  } catch (error) {
    if (!knowledgeSessionIsCurrent(session)) throw error;
    const detail = conciseError(error);
    try {
      await stopCorePreparation(context, currentStage, detail, session);
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
  signal?: AbortSignal,
) {
  assertKnowledgeSession(session);
  try {
    await setKnowledgeStage(context, session, {
      id: "external",
      status: "running",
    });
  } catch (error) {
    if (!knowledgeSessionIsCurrent(session)) throw error;
    await markExternalPersistenceFailure(context, session, error);
    throw error;
  }
  assertKnowledgeSession(session);
  if (!queries.length) {
    try {
      assertKnowledgeSession(session);
      await persistBackgroundResearch({
        context,
        summary: "",
        queries: [],
        sources: [],
        status: "empty",
        assertActive: () => assertKnowledgeSession(session),
      });
      await setKnowledgeStage(context, session, {
        id: "external",
        status: "skipped",
        detail: "论文分析未提出外部检索问题",
      });
    } catch (error) {
      if (!knowledgeSessionIsCurrent(session)) throw error;
      await markExternalPersistenceFailure(context, session, error);
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
          maxOutputTokens: EXTERNAL_MAX_OUTPUT_TOKENS,
          maxWebSearchCalls: MAXIMUM_SEARCH_QUERIES,
        }),
    });
    assertKnowledgeSession(session);
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
    try {
      await persistExternalWarning(context, queries, error, session);
    } catch (warningError) {
      if (!knowledgeSessionIsCurrent(session)) throw warningError;
      try {
        await markExternalPersistenceFailure(context, session, warningError);
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
      summary: parsed.summary,
      queries,
      sources: parsed.sources,
      assertActive: () => assertKnowledgeSession(session),
    });
    await setKnowledgeStage(context, session, {
      id: "external",
      status: parsed.sources.length ? "complete" : "warning",
      detail: parsed.sources.length ? undefined : "未找到可用外部来源",
    });
  } catch (error) {
    if (!knowledgeSessionIsCurrent(session)) throw error;
    await markExternalPersistenceFailure(context, session, error);
    throw error;
  }
}

async function markExternalPersistenceFailure(
  context: ValidatedPaperContext,
  session: number,
  error: unknown,
): Promise<void> {
  const detail = conciseError(error);
  try {
    await setKnowledgeStage(context, session, {
      id: "external",
      status: "error",
      detail: `外部知识文件写入失败：${detail}`,
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
): Promise<void> {
  const detail = conciseError(error);
  await persistBackgroundResearch({
    context,
    summary: "",
    queries,
    sources: [],
    failures: [{ provider: "web-search", message: detail }],
    status: "warning",
    assertActive: () => assertKnowledgeSession(session),
  });
  await setKnowledgeStage(context, session, {
    id: "external",
    status: "warning",
    detail: "1 个来源受限",
  });
}

async function stopStaleExternalPreparation(
  context: ValidatedPaperContext,
  queries: string[],
  session: number,
): Promise<void> {
  const detail = "上一轮外部补充未正常结束，已停止且不会自动重试";
  try {
    await persistBackgroundResearch({
      context,
      summary: "",
      queries,
      sources: [],
      failures: [{ provider: "web-search", message: detail }],
      status: "warning",
      assertActive: () => assertKnowledgeSession(session),
    });
    await setKnowledgeStage(context, session, {
      id: "external",
      status: "warning",
      detail,
    });
  } catch (error) {
    if (!knowledgeSessionIsCurrent(session)) throw error;
    await markExternalPersistenceFailure(context, session, error);
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
  activeKnowledgeCancellations.add(cancel);
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
    activeKnowledgeCancellations.delete(cancel);
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
  await setPreparationStages(context, [...updates], () =>
    assertKnowledgeSession(session),
  );
}

function stageStatus(record: PreparationRecord, id: string): string {
  return record.stages.find((stage) => stage.id === id)?.status || "pending";
}

async function stopStaleCorePreparation(
  context: ValidatedPaperContext,
  stage: "background" | "terminology",
  session: number,
): Promise<void> {
  await stopCorePreparation(
    context,
    stage,
    "上一轮知识准备未正常结束，已停止且不会自动重试",
    session,
  );
}

async function stopCorePreparation(
  context: ValidatedPaperContext,
  stage: "background" | "terminology",
  detail: string,
  session: number,
): Promise<void> {
  await setPreparationStages(
    context,
    [
      { id: stage, status: "error", detail },
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
    () => assertKnowledgeSession(session),
  );
}

function setKnowledgeStage(
  context: ValidatedPaperContext,
  session: number,
  update: {
    id: PreparationStageId;
    status: PreparationStageStatus;
    detail?: string;
  },
): Promise<PreparationRecord> {
  return setPreparationStage({
    context,
    ...update,
    assertActive: () => assertKnowledgeSession(session),
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

function knowledgeSessionIsCurrent(session: number): boolean {
  return knowledgeSessionActive && session === knowledgeSessionGeneration;
}

function assertKnowledgeSession(session: number): void {
  if (!knowledgeSessionIsCurrent(session)) {
    throw new Error("Paper knowledge preparation session is no longer active");
  }
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
  return `${context.identity.libraryID}:${context.identity.parentItemKey}:${context.fullMdSha256}`;
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
