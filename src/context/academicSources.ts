import type { BackgroundSource, ValidatedPaperContext } from "./runtime";

export type AcademicSourceFailure = {
  provider: "crossref" | "semantic-scholar";
  message: string;
};

export type AcademicSourceSearchResult = {
  query: string;
  sources: BackgroundSource[];
  failures: AcademicSourceFailure[];
};

type HttpGet = (url: string) => Promise<{ status: number; response: unknown }>;

export async function searchAcademicSources(
  context: ValidatedPaperContext,
  httpGet: HttpGet = requestJson,
): Promise<AcademicSourceSearchResult> {
  const query = context.identity.title || context.identity.doi;
  if (!query.trim())
    throw new Error(
      "Paper has neither DOI nor title for academic source lookup",
    );
  const results = await Promise.all([
    collectProvider("crossref", () => searchCrossref(query, httpGet)),
    collectProvider("semantic-scholar", () =>
      searchSemanticScholar(query, httpGet),
    ),
  ]);
  return {
    query,
    sources: deduplicateSources(results.flatMap((result) => result.sources)),
    failures: results.flatMap((result) => result.failures),
  };
}

async function searchCrossref(
  query: string,
  httpGet: HttpGet,
): Promise<BackgroundSource[]> {
  const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=3&select=DOI,title,abstract,URL`;
  const xhr = await httpGet(url);
  if (xhr.status < 200 || xhr.status >= 300) {
    throw new Error(`Crossref lookup failed with HTTP ${xhr.status}`);
  }
  return parseCrossrefResponse(xhr.response);
}

async function searchSemanticScholar(
  query: string,
  httpGet: HttpGet,
): Promise<BackgroundSource[]> {
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=3&fields=title,url,abstract,externalIds`;
  const xhr = await httpGet(url);
  if (xhr.status < 200 || xhr.status >= 300) {
    throw new Error(`Semantic Scholar lookup failed with HTTP ${xhr.status}`);
  }
  return parseSemanticScholarResponse(xhr.response);
}

async function requestJson(
  url: string,
): Promise<{ status: number; response: unknown }> {
  return Zotero.HTTP.request("GET", url, { responseType: "json" });
}

async function collectProvider(
  provider: AcademicSourceFailure["provider"],
  search: () => Promise<BackgroundSource[]>,
): Promise<{
  sources: BackgroundSource[];
  failures: AcademicSourceFailure[];
}> {
  try {
    return { sources: await search(), failures: [] };
  } catch (error) {
    return {
      sources: [],
      failures: [{ provider, message: String(error) }],
    };
  }
}

export function parseCrossrefResponse(value: unknown): BackgroundSource[] {
  const items = (value as any)?.message?.items;
  if (!Array.isArray(items))
    throw new Error("Crossref response has no items array");
  return items.flatMap((item: any) => {
    const title = Array.isArray(item?.title) ? item.title[0] : "";
    const doi = typeof item?.DOI === "string" ? item.DOI : "";
    const url = doi ? `https://doi.org/${encodeURIComponent(doi)}` : item?.URL;
    if (typeof title !== "string" || typeof url !== "string") return [];
    return [{ title, url, snippet: stripMarkup(String(item?.abstract || "")) }];
  });
}

export function parseSemanticScholarResponse(
  value: unknown,
): BackgroundSource[] {
  const items = (value as any)?.data;
  if (!Array.isArray(items))
    throw new Error("Semantic Scholar response has no data array");
  return items.flatMap((item: any) => {
    if (typeof item?.title !== "string") return [];
    const doi = item?.externalIds?.DOI;
    const url =
      typeof doi === "string"
        ? `https://doi.org/${encodeURIComponent(doi)}`
        : item?.url;
    if (typeof url !== "string") return [];
    return [{ title: item.title, url, snippet: String(item?.abstract || "") }];
  });
}

function stripMarkup(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function deduplicateSources(sources: BackgroundSource[]): BackgroundSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
}
