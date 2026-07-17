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
  TerminologyEntry,
  ValidatedPaperContext,
  persistBackgroundResearch,
  persistCoreBackground,
  persistTerminology,
  readBackgroundResearchRecord,
  readPreparationRecord,
  setPreparationStage,
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
const researchQueries = new Map<string, string[]>();

export async function continuePaperLearning(
  context: ValidatedPaperContext,
): Promise<void> {
  await ensureCorePaperKnowledge(context);
  await ensureExternalKnowledgeResearch(context);
}

export async function ensureCorePaperKnowledge(
  context: ValidatedPaperContext,
  signal?: AbortSignal,
): Promise<void> {
  const preparation = await readPreparationRecord(context);
  const complete = (id: string) =>
    preparation.stages.find((stage) => stage.id === id)?.status === "complete";
  if (complete("background") && complete("terminology")) return;
  const key = contextKey(context);
  const active = coreJobs.get(key);
  if (active) return active;
  const job = runCoreKnowledge(context, signal).finally(() =>
    coreJobs.delete(key),
  );
  coreJobs.set(key, job);
  return job;
}

export async function ensureExternalKnowledgeResearch(
  context: ValidatedPaperContext,
  signal?: AbortSignal,
): Promise<void> {
  const existing = await readBackgroundResearchRecord(context);
  if (["complete", "empty", "warning"].includes(existing.status)) return;
  const key = contextKey(context);
  const active = externalJobs.get(key);
  if (active) return active;
  const job = runExternalResearch(context, signal).finally(() =>
    externalJobs.delete(key),
  );
  externalJobs.set(key, job);
  return job;
}

async function runCoreKnowledge(
  context: ValidatedPaperContext,
  signal?: AbortSignal,
) {
  await setPreparationStage({ context, id: "background", status: "running" });
  await setPreparationStage({ context, id: "terminology", status: "running" });
  let backgroundComplete = false;
  try {
    const result = await runLegacyCodexRequest({
      apiUrl: requiredPref("paper.codexApiUrl"),
      model: requiredPref("paper.codexModel"),
      effort: String(getPref("paper.codexEffort") || ""),
      instructions: CORE_KNOWLEDGE_DEVELOPER_INSTRUCTIONS,
      prompt: buildCoreKnowledgePrompt(context),
      signal,
    });
    const parsed = parseCoreKnowledgeResult(result.text);
    const terms = validatePaperTerminology(parsed.terms, context);
    if (!terms.length)
      throw new Error("Core knowledge contains no paper-evidenced terminology");
    await persistCoreBackground({
      context,
      markdown: formatCoreBackground(parsed),
    });
    await setPreparationStage({
      context,
      id: "background",
      status: "complete",
    });
    backgroundComplete = true;
    await persistTerminology({ context, entries: terms });
    await setPreparationStage({
      context,
      id: "terminology",
      status: "complete",
    });
    researchQueries.set(contextKey(context), parsed.searchQueries);
  } catch (error) {
    const detail = conciseError(error);
    if (!backgroundComplete) {
      await setPreparationStage({
        context,
        id: "background",
        status: "error",
        detail,
      });
    }
    await setPreparationStage({
      context,
      id: "terminology",
      status: "error",
      detail,
    });
    throw error;
  }
}

async function runExternalResearch(
  context: ValidatedPaperContext,
  signal?: AbortSignal,
) {
  await setPreparationStage({ context, id: "external", status: "running" });
  const queries = researchQueries.get(contextKey(context)) ?? [
    ...deriveSearchQueries(context.background),
  ];
  if (!queries.length)
    queries.push(`${context.identity.title} terminology background`);
  try {
    const result = await runLegacyCodexRequest({
      apiUrl: requiredPref("paper.codexApiUrl"),
      model: requiredPref("paper.codexModel"),
      effort: String(getPref("paper.codexEffort") || ""),
      instructions: EXTERNAL_RESEARCH_DEVELOPER_INSTRUCTIONS,
      prompt: buildExternalResearchPrompt({ context, queries }),
      signal,
      webSearch: true,
      requireWebSearch: false,
    });
    const parsed = parseResearchResult(result.text);
    await persistBackgroundResearch({
      context,
      summary: parsed.summary,
      queries,
      sources: parsed.sources,
    });
    await setPreparationStage({
      context,
      id: "external",
      status: parsed.sources.length ? "complete" : "warning",
      detail: parsed.sources.length ? undefined : "未找到可用外部来源",
    });
  } catch (error) {
    const detail = conciseError(error);
    await persistBackgroundResearch({
      context,
      summary: "",
      queries,
      sources: [],
      failures: [{ provider: "web-search", message: detail }],
      status: "warning",
    });
    await setPreparationStage({
      context,
      id: "external",
      status: "warning",
      detail: "1 个来源受限",
    });
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
  const terms = (parsed.terms as unknown[]).map((term, index) => {
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
    return item as CoreKnowledge["terms"][number];
  });
  return {
    field: parsed.field as string,
    problem: parsed.problem as string,
    workflow: parsed.workflow as string,
    method: parsed.method as string,
    evaluation: parsed.evaluation as string,
    translationRisks: validateStringArray(
      parsed.translationRisks,
      "translationRisks",
    ),
    openQuestions: validateStringArray(parsed.openQuestions, "openQuestions"),
    searchQueries: validateStringArray(parsed.searchQueries, "searchQueries"),
    terms,
  };
}

export function validatePaperTerminology(
  terms: CoreKnowledge["terms"],
  context: ValidatedPaperContext,
): TerminologyEntry[] {
  const lower = context.markdown.toLocaleLowerCase();
  return terms.flatMap((term) => {
    const offset = lower.indexOf(term.observed.toLocaleLowerCase());
    if (offset < 0) return [];
    const chunk = context.index.chunks.find(
      (item) => offset >= item.charStart && offset < item.charEnd,
    );
    return [
      {
        ...term,
        evidence: `${chunk?.heading || "Paper"}; chars ${offset}-${offset + term.observed.length}`,
        sourceLevel: "paper" as const,
        confidence: "high" as const,
      },
    ];
  });
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
  const sources = parsed.sources.map((source, index) => {
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
    return item as BackgroundSource;
  });
  if (sources.length && !parsed.summary.trim())
    throw new Error("Background research with sources requires a summary");
  return { summary: parsed.summary, sources };
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
    "### 研究问题与工作流",
    "",
    value.problem,
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
    .filter(Boolean);
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
  return value.map((item) => item.trim()).filter(Boolean);
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
