import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCrossrefResponse,
  parseSemanticScholarResponse,
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
