import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPaperIndex,
  parseAndValidateManifest,
  parseAndValidateProvenance,
  retrievePassages,
} from "../src/context/paperContext";

const identity = {
  libraryID: 1,
  parentItemKey: "ABCD1234",
  attachmentID: 42,
  attachmentKey: "WXYZ5678",
  title: "Graph Translation",
  doi: "10.1000/example",
};

test("validates provenance against live Zotero identity", () => {
  const result = parseAndValidateProvenance(
    JSON.stringify({
      kind: "llm-for-zotero/mineru-cache-source",
      version: 2,
      attachmentId: 42,
      attachmentKey: "WXYZ5678",
      parentItemKey: "ABCD1234",
      origin: "parsed",
      recordedAt: "2026-07-17T00:00:00Z",
    }),
    identity,
  );
  assert.equal(result.attachmentKey, identity.attachmentKey);
});

test("rejects mismatched provenance without guessing", () => {
  assert.throws(
    () =>
      parseAndValidateProvenance(
        JSON.stringify({
          kind: "llm-for-zotero/mineru-cache-source",
          version: 2,
          attachmentId: 42,
          attachmentKey: "BADK5678",
          parentItemKey: "ABCD1234",
          origin: "parsed",
          recordedAt: "2026-07-17T00:00:00Z",
        }),
        identity,
      ),
    /attachmentKey/,
  );
});

test("uses JavaScript UTF-16 lengths for manifest validation", () => {
  const markdown = "# 结果\n😀 graph timing";
  const manifest = parseAndValidateManifest(
    JSON.stringify({
      totalChars: markdown.length,
      sections: [{ heading: "结果", charStart: 0, charEnd: markdown.length }],
    }),
    markdown,
  );
  assert.equal(manifest.totalChars, markdown.length);
  assert.throws(
    () =>
      parseAndValidateManifest(
        JSON.stringify({ totalChars: Buffer.byteLength(markdown) }),
        markdown,
      ),
    /UTF-16 length/,
  );
});

test("builds an offset-only index and retrieves relevant passages", () => {
  const markdown = [
    "# Introduction\nGraph timing models estimate delay.",
    "# Method\nThe heterogeneous graph attention network predicts timing arcs.",
  ].join("\n\n");
  const methodStart = markdown.indexOf("# Method");
  const manifest = {
    totalChars: markdown.length,
    sections: [
      { heading: "Introduction", charStart: 0, charEnd: methodStart },
      { heading: "Method", charStart: methodStart, charEnd: markdown.length },
    ],
  };
  const index = buildPaperIndex({
    parentItemKey: "ABCD1234",
    fullMdSha256: "abc",
    markdown,
    manifest,
    updatedAt: "2026-07-17T00:00:00Z",
  });
  assert.equal("text" in index.chunks[0], false);
  const passages = retrievePassages(markdown, index, "attention network");
  assert.equal(passages[0].heading, "Method");
  assert.match(passages[0].text, /heterogeneous graph attention/);
});
