import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPaperIndex,
  alignSelectionHyphens,
  parseAndValidateManifest,
  parseAndValidateProvenance,
  retrievePassages,
  selectKnowledgePassages,
} from "../src/context/paperContext";
import { buildTranslationPrompt } from "../src/context/prompts";

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
  assert.throws(
    () =>
      parseAndValidateManifest(
        JSON.stringify({
          totalChars: markdown.length,
          sections: [
            { heading: "later", charStart: 8, charEnd: markdown.length },
            { heading: "earlier", charStart: 0, charEnd: 8 },
          ],
        }),
        markdown,
      ),
    /out of order or overlap/,
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
    manifestSha256: "manifest",
    markdown,
    manifest,
    updatedAt: "2026-07-17T00:00:00Z",
  });
  assert.equal("text" in index.chunks[0], false);
  const passages = retrievePassages(markdown, index, "attention network");
  assert.equal(passages[0].heading, "Method");
  assert.match(passages[0].text, /heterogeneous graph attention/);
});

test("keeps one stable prompt prefix for nearby selections in the same passage window", () => {
  const paragraphs = Array.from(
    { length: 8 },
    (_, index) =>
      `paragraph-${index} unique-${index} ${String.fromCharCode(97 + index).repeat(920)}`,
  );
  const markdown = `# Method\n${paragraphs.join("\n\n")}`;
  const index = buildPaperIndex({
    parentItemKey: "ABCD1234",
    fullMdSha256: "paper",
    manifestSha256: "manifest",
    markdown,
    manifest: {
      totalChars: markdown.length,
      sections: [{ heading: "Method", charStart: 0, charEnd: markdown.length }],
    },
    updatedAt: "2026-08-03T00:00:00Z",
  });
  const firstInput = "paragraph-1 unique-1";
  const secondInput = "paragraph-2 unique-2";
  const distantInput = "paragraph-6 unique-6";
  const firstPassages = retrievePassages(markdown, index, firstInput);
  const secondPassages = retrievePassages(markdown, index, secondInput);
  const distantPassages = retrievePassages(markdown, index, distantInput);

  assert.deepEqual(
    firstPassages.map((passage) => passage.id),
    secondPassages.map((passage) => passage.id),
  );
  assert.deepEqual(
    firstPassages.map((passage) => passage.charStart),
    [...firstPassages]
      .sort((left, right) => left.charStart - right.charStart)
      .map((passage) => passage.charStart),
  );
  assert.notDeepEqual(
    firstPassages.map((passage) => passage.id),
    distantPassages.map((passage) => passage.id),
  );
  assert.ok(
    distantPassages.some((passage) => passage.text.includes(distantInput)),
  );

  const context = {
    identity,
    terminology: "stable terminology",
    background: "stable background",
    passages: firstPassages,
  };
  const firstPrompt = buildTranslationPrompt({
    context: context as any,
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    input: firstInput,
  });
  const secondPrompt = buildTranslationPrompt({
    context: { ...context, passages: secondPassages } as any,
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    input: secondInput,
  });
  const dynamicMarker = "Text to translate:\n";
  assert.equal(
    firstPrompt.slice(0, firstPrompt.indexOf(dynamicMarker)),
    secondPrompt.slice(0, secondPrompt.indexOf(dynamicMarker)),
  );
  assert.notEqual(firstPrompt, secondPrompt);
});

test("uses one ranked passage-window rule for repeated text", () => {
  const paragraphs = [
    `shared marker ${"a".repeat(920)}`,
    `shared marker shared marker shared marker ${"b".repeat(920)}`,
  ];
  const markdown = `# Method\n${paragraphs.join("\n\n")}`;
  const index = buildPaperIndex({
    parentItemKey: "ABCD1234",
    fullMdSha256: "paper",
    manifestSha256: "manifest",
    markdown,
    manifest: {
      totalChars: markdown.length,
      sections: [{ heading: "Method", charStart: 0, charEnd: markdown.length }],
    },
  });

  const passages = retrievePassages(markdown, index, "shared marker");
  assert.deepEqual(
    passages.map((passage) => passage.id),
    [0, 1],
  );
  assert.equal(passages.find((passage) => passage.id === 1)?.score, 6);
});

test("rebuilds real Markdown headings when the manifest has no sections", () => {
  const markdown = [
    "# Abstract\nStandard cell characterization models timing arcs.",
    "# Introduction\nSSTA evaluates delay across PVT corners.",
    "# Proposed HGAT Framework\nHGAT performs node-level aggregation for RC reduction.",
    "# Experiments\nThe 3σ percentile and rRMSE measure accuracy.",
    "# Conclusion\nThe heterogeneous graph improves prediction.",
  ].join("\n\n");
  const index = buildPaperIndex({
    parentItemKey: "ABCD1234",
    fullMdSha256: "sample",
    manifestSha256: "manifest",
    markdown,
    manifest: { noSections: true, totalChars: markdown.length },
    updatedAt: "2026-07-17T00:00:00Z",
  });
  assert.deepEqual(
    [...new Set(index.chunks.map((chunk) => chunk.heading))],
    [
      "Abstract",
      "Introduction",
      "Proposed HGAT Framework",
      "Experiments",
      "Conclusion",
    ],
  );
  for (const [query, heading] of [
    ["timing arc", "Abstract"],
    ["RC reduction", "Proposed HGAT Framework"],
    ["HGAT", "Proposed HGAT Framework"],
    ["3σ", "Experiments"],
  ]) {
    assert.equal(retrievePassages(markdown, index, query)[0]?.heading, heading);
  }
});

test("samples multiple parts of an unsectioned paper within the fixed budget", () => {
  const markdown = Array.from(
    { length: 12 },
    (_, index) => `paragraph ${index} ${"x".repeat(900)}`,
  ).join("\n\n");
  const index = buildPaperIndex({
    parentItemKey: "ABCD1234",
    fullMdSha256: "sample",
    manifestSha256: "manifest",
    markdown,
    manifest: { noSections: true, totalChars: markdown.length },
  });
  const passages = selectKnowledgePassages(markdown, index);
  assert.ok(passages.length > 1);
  assert.ok(
    passages.reduce((sum, passage) => sum + passage.text.length, 0) <= 8_000,
  );
  assert.ok(passages.at(-1)!.charStart > passages[0].charStart);
});

test("balances the bounded knowledge pass across method, evaluation, and conclusion", () => {
  const section = (heading: string, marker: string) =>
    `# ${heading}\n${marker} ${"evidence ".repeat(260)}`;
  const markdown = [
    section("Paper title", "abstract"),
    section("I. INTRODUCTION", "introduction"),
    "# III. PROPOSED FRAMEWORK",
    section("A. Overview", "method"),
    section("C. Parasitic RC Reduction Approach", "reduction"),
    "# IV. EXPERIMENT SETUP AND RESULTS",
    section("B. Prediction Accuracy Comparison", "evaluation"),
    section("V. CONCLUSION", "conclusion"),
  ].join("\n\n");
  const index = buildPaperIndex({
    parentItemKey: "ABCD1234",
    fullMdSha256: "sample",
    manifestSha256: "manifest",
    markdown,
    manifest: { noSections: true, totalChars: markdown.length },
  });
  const passages = selectKnowledgePassages(markdown, index);
  const headings = passages.map((passage) => passage.heading).join("\n");
  assert.match(headings, /INTRODUCTION/);
  assert.match(headings, /Overview/);
  assert.match(headings, /Parasitic RC Reduction/);
  assert.match(headings, /Prediction Accuracy/);
  assert.match(headings, /CONCLUSION/);
  assert.ok(
    passages.reduce((sum, passage) => sum + passage.text.length, 0) <= 8_000,
  );
});

test("removes a line-wrap hyphen only when validated Markdown proves the word", () => {
  const markdown = "A well-known characterization reduction method.";
  assert.equal(
    alignSelectionHyphens("well-known charac-terization", markdown),
    "well-known characterization",
  );
  assert.equal(
    alignSelectionHyphens("paper-specific term", markdown),
    "paper-specific term",
  );
  assert.equal(alignSelectionHyphens("re-duction", markdown), "reduction");
});
