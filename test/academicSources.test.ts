import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCrossrefResponse,
  parseSemanticScholarResponse,
  searchAcademicSources,
} from "../src/context/academicSources";

test("parses Crossref works into background sources", () => {
  assert.deepEqual(
    parseCrossrefResponse({
      message: {
        items: [
          {
            DOI: "10.1/x",
            title: ["Paper"],
            abstract: "<jats:p>Text</jats:p>",
          },
        ],
      },
    }),
    [{ title: "Paper", url: "https://doi.org/10.1%2Fx", snippet: "Text" }],
  );
});

test("prefers DOI links for Semantic Scholar records", () => {
  assert.equal(
    parseSemanticScholarResponse({
      data: [
        {
          title: "Paper",
          url: "https://example.test",
          abstract: "A",
          externalIds: { DOI: "10.2/y" },
        },
      ],
    })[0].url,
    "https://doi.org/10.2%2Fy",
  );
});

test("uses the validated paper title and records a rate-limited provider", async () => {
  const requested: string[] = [];
  const result = await searchAcademicSources(
    {
      identity: { title: "Paper-derived query", doi: "10.1/doi" },
    } as any,
    async (url) => {
      requested.push(url);
      if (url.includes("semanticscholar")) {
        throw new Error("HTTP 429");
      }
      return { status: 200, response: { message: { items: [] } } };
    },
  );
  assert.equal(result.query, "Paper-derived query");
  assert.equal(result.sources.length, 0);
  assert.deepEqual(result.failures, [
    { provider: "semantic-scholar", message: "Error: HTTP 429" },
  ]);
  assert.ok(
    requested.every((url) =>
      url.includes(encodeURIComponent("Paper-derived query")),
    ),
  );
});
