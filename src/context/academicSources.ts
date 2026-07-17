import type { BackgroundSource, ValidatedPaperContext } from "./runtime";

export async function searchAcademicSources(
  context: ValidatedPaperContext,
): Promise<BackgroundSource[]> {
  const query = context.identity.doi || context.identity.title;
  if (!query.trim())
    throw new Error(
      "Paper has neither DOI nor title for academic source lookup",
    );
  const crossref = await searchCrossref(query);
  const semanticScholar = await searchSemanticScholar(query);
  return deduplicateSources([...crossref, ...semanticScholar]);
}

async function searchCrossref(query: string): Promise<BackgroundSource[]> {
  const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=3&select=DOI,title,abstract,URL`;
  const xhr = await Zotero.HTTP.request("GET", url, { responseType: "json" });
  if (xhr.status < 200 || xhr.status >= 300) {
    throw new Error(`Crossref lookup failed with HTTP ${xhr.status}`);
  }
  return parseCrossrefResponse(xhr.response);
}

async function searchSemanticScholar(
  query: string,
): Promise<BackgroundSource[]> {
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=3&fields=title,url,abstract,externalIds`;
  const xhr = await Zotero.HTTP.request("GET", url, { responseType: "json" });
  if (xhr.status < 200 || xhr.status >= 300) {
    throw new Error(`Semantic Scholar lookup failed with HTTP ${xhr.status}`);
  }
  return parseSemanticScholarResponse(xhr.response);
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
