import assert from "node:assert/strict";
import test from "node:test";
import { parseResearchResult } from "../src/context/research";

test("parses strict background research JSON", () => {
  const result = parseResearchResult(
    JSON.stringify({
      summary: "Graph timing background.",
      sources: [
        {
          title: "Publisher",
          url: "https://example.org/paper",
          snippet: "Primary record",
        },
      ],
    }),
  );
  assert.equal(result.sources.length, 1);
});

test("rejects markdown fences instead of silently recovering JSON", () => {
  assert.throws(
    () => parseResearchResult('```json\n{"summary":"x","sources":[]}\n```'),
    /invalid JSON/,
  );
});
