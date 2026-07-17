import { runLegacyCodexRequest } from "../codex/legacyClient";
import { getPref } from "../utils/prefs";
import {
  BackgroundSource,
  ValidatedPaperContext,
  persistBackgroundResearch,
  readBackgroundResearchRecord,
} from "./runtime";
import {
  RESEARCH_DEVELOPER_INSTRUCTIONS,
  buildResearchPrompt,
} from "./prompts";
import { searchAcademicSources } from "./academicSources";

export async function ensureBackgroundResearch(
  context: ValidatedPaperContext,
  signal?: AbortSignal,
): Promise<void> {
  const existing = await readBackgroundResearchRecord(context);
  if (existing.status === "complete" || existing.status === "empty") return;

  const key = `${context.identity.libraryID}:${context.identity.parentItemKey}:${context.fullMdSha256}`;
  const active = backgroundResearchJobs.get(key);
  if (active) return active;
  const job = runBackgroundResearch(context, signal).finally(() => {
    backgroundResearchJobs.delete(key);
  });
  backgroundResearchJobs.set(key, job);
  return job;
}

const backgroundResearchJobs = new Map<string, Promise<void>>();

async function runBackgroundResearch(
  context: ValidatedPaperContext,
  signal?: AbortSignal,
): Promise<void> {
  const academicResult = await searchAcademicSources(context);
  const result = await runLegacyCodexRequest({
    apiUrl: requiredPref("paper.codexApiUrl"),
    model: requiredPref("paper.codexModel"),
    effort: String(getPref("paper.codexEffort") || ""),
    instructions: RESEARCH_DEVELOPER_INSTRUCTIONS,
    prompt: buildResearchPrompt(
      context,
      academicResult.sources,
      academicResult.failures,
    ),
    signal,
    webSearch: true,
    requireWebSearch: true,
  });
  const parsed = parseResearchResult(result.text);
  await persistBackgroundResearch({
    context,
    summary: parsed.summary,
    queries: buildResearchQueries(context, academicResult.query),
    sources: deduplicateSources([...academicResult.sources, ...parsed.sources]),
    failures: academicResult.failures,
  });
}

function buildResearchQueries(
  context: ValidatedPaperContext,
  academicQuery: string,
): string[] {
  return [
    academicQuery,
    context.identity.doi,
    ...context.passages.map((passage) => passage.heading),
  ]
    .map((query) => query.trim())
    .filter(
      (query, index, queries) => query && queries.indexOf(query) === index,
    );
}

function deduplicateSources(sources: BackgroundSource[]): BackgroundSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
}

export function parseResearchResult(value: string): {
  summary: string;
  sources: BackgroundSource[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `Codex background research returned invalid JSON: ${String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Codex background research result must be an object");
  }
  const result = parsed as { summary?: unknown; sources?: unknown };
  if (typeof result.summary !== "string" || !Array.isArray(result.sources)) {
    throw new Error(
      "Codex background research result is missing summary or sources",
    );
  }
  const sources = result.sources.map((source, index) => {
    if (!source || typeof source !== "object") {
      throw new Error(`Background source ${index} must be an object`);
    }
    const item = source as Record<string, unknown>;
    if (
      typeof item.title !== "string" ||
      typeof item.url !== "string" ||
      typeof item.snippet !== "string"
    ) {
      throw new Error(`Background source ${index} is incomplete`);
    }
    return { title: item.title, url: item.url, snippet: item.snippet };
  });
  return { summary: result.summary, sources };
}

function requiredPref(key: string): string {
  const value = String(getPref(key) || "").trim();
  if (!value) throw new Error(`Required preference is empty: ${key}`);
  return value;
}
