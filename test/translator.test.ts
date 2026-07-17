import assert from "node:assert/strict";
import test from "node:test";
import { parseTerminologyResult } from "../src/backends/translator";

test("parses strict terminology entries", () => {
  assert.deepEqual(
    parseTerminologyResult(
      '{"entries":[{"observed":"token","canonical":"token","translation":"词元","category":"NLP","definition":"A text unit."}]}',
    ),
    [
      {
        observed: "token",
        canonical: "token",
        translation: "词元",
        category: "NLP",
        definition: "A text unit.",
        evidence: "Selected text",
        sourceLevel: "paper",
        confidence: "medium",
      },
    ],
  );
});

test("rejects incomplete terminology entries", () => {
  assert.throws(
    () => parseTerminologyResult('{"entries":[{"observed":"x"}]}'),
    /incomplete/,
  );
});
