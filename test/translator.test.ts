import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  formatTranslationLayout,
  parseTerminologyResult,
} from "../src/backends/translator";

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

test("keeps translated bullet items on separate lines", () => {
  assert.equal(
    formatTranslationLayout("• First item\n• Second item", "• 第一项 • 第二项"),
    "• 第一项\n• 第二项",
  );
});

test("does not await paper learning or terminology updates before returning translation", async () => {
  const source = await readFile(
    new URL("../src/backends/translator.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /void continuePaperLearning\(context\)/);
  assert.match(source, /void updateTerminology\(context,/);
  assert.doesNotMatch(
    source,
    /await ensureCorePaperKnowledge|await updateTerminology/,
  );
});

test("rejects incomplete terminology entries", () => {
  assert.throws(
    () => parseTerminologyResult('{"entries":[{"observed":"x"}]}'),
    /incomplete/,
  );
});
