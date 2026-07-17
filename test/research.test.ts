import assert from "node:assert/strict";
import test from "node:test";
import { buildPaperIndex } from "../src/context/paperContext";
import { buildCoreKnowledgePrompt } from "../src/context/prompts";
import {
  parseCoreKnowledgeResult,
  parseResearchResult,
  validatePaperTerminology,
} from "../src/context/research";

test("parses tiered background research JSON", () => {
  const result = parseResearchResult(
    JSON.stringify({
      summary: "用于消歧的通用背景。",
      sources: [
        {
          title: "Official standard",
          url: "https://example.org/standard",
          snippet: "Normative definition",
          sourceLevel: "official",
          purpose: "确认规范术语",
        },
      ],
    }),
  );
  assert.equal(result.sources[0].sourceLevel, "official");
});

test("rejects markdown fences instead of silently recovering JSON", () => {
  assert.throws(
    () => parseResearchResult('```json\n{"summary":"x","sources":[]}\n```'),
    /invalid JSON/,
  );
});

test("accepts the paper typo but records its canonical aggregation term", () => {
  const markdown =
    "# Method\nThe Node level aggression module performs graph updates.";
  const index = buildPaperIndex({
    parentItemKey: "ABCD1234",
    fullMdSha256: "abc",
    markdown,
    manifest: { noSections: true, totalChars: markdown.length },
  });
  const entries = validatePaperTerminology(
    [
      {
        observed: "Node level aggression",
        canonical: "node-level aggregation",
        translation: "节点级聚合",
        category: "graph operation",
        definition: "Aggregates neighboring node features.",
      },
    ],
    { markdown, index } as any,
  );
  assert.equal(entries[0].canonical, "node-level aggregation");
  assert.match(entries[0].evidence, /Method; chars/);
  assert.equal(
    validatePaperTerminology([{ ...entries[0], observed: "invented term" }], {
      markdown,
      index,
    } as any).length,
    0,
  );
});

test("parses complete core knowledge and rejects missing stages", () => {
  const value = {
    field: "EDA",
    problem: "delay variation",
    workflow: "characterization",
    method: "HGAT",
    evaluation: "rRMSE",
    translationRisks: ["cell means standard cell"],
    openQuestions: ["Liberty variance format"],
    searchQueries: ["Liberty LVF official"],
    terms: [
      {
        observed: "HGAT",
        canonical: "heterogeneous graph attention network",
        translation: "异构图注意力网络",
        category: "model",
        definition: "graph model",
      },
    ],
  };
  assert.equal(parseCoreKnowledgeResult(JSON.stringify(value)).terms.length, 1);
  assert.throws(
    () =>
      parseCoreKnowledgeResult(JSON.stringify({ ...value, method: undefined })),
    /method/,
  );
});

test("requests the sample EDA terminology and canonical typo mapping", () => {
  const markdown =
    "# Method\nNode level aggression is used by HGAT for a timing arc and 3σ percentile.";
  const index = buildPaperIndex({
    parentItemKey: "ABCD1234",
    fullMdSha256: "abc",
    markdown,
    manifest: { noSections: true, totalChars: markdown.length },
  });
  const prompt = buildCoreKnowledgePrompt({
    markdown,
    index,
    identity: { title: "EDA paper", doi: "" },
  } as any);
  assert.match(prompt, /standard cell.*library characterization.*timing arc/);
  assert.match(
    prompt,
    /Node level aggression.*node-level aggregation.*节点级聚合/,
  );
});
