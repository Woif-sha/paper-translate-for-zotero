import assert from "node:assert/strict";
import test from "node:test";
import { parseTerminologyResult } from "../src/backends/translator";

test("parses strict terminology entries", () => {
  assert.deepEqual(
    parseTerminologyResult(
      '{"entries":[{"source":"token","translation":"词元","evidence":"Methods"}]}',
    ),
    [{ source: "token", translation: "词元", evidence: "Methods" }],
  );
});

test("rejects incomplete terminology entries", () => {
  assert.throws(
    () => parseTerminologyResult('{"entries":[{"source":"x"}]}'),
    /incomplete/,
  );
});
