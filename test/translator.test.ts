import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  formatTranslationLayout,
  resolveTranslationRequest,
  schedulePaperLearningAfterTranslation,
} from "../src/backends/translator";
import { MineruMarkdownUnavailableError } from "../src/context/runtime";

test("keeps translated bullet items on separate lines", () => {
  assert.equal(
    formatTranslationLayout(
      "  • First item\n  • Second item",
      "• 第一项 • 第二项",
    ),
    "• 第一项\n• 第二项",
  );
});

test("restores numeric script direction from the validated source", () => {
  const source =
    "random forest<sup>38</sup>, XGBoost<sup>7</sup>, CatBoost<sup>9</sup>, LightGBM<sup>8</sup>, SVMs<sup>39</sup>, and H<sub>2</sub>O";
  const translation =
    "随机森林~38~、XGBoost₇、CatBoost^9、LightGBM<sub>8</sub>、SVM~39~，以及 H~2~O";

  assert.equal(
    formatTranslationLayout(source, translation),
    "随机森林^38^、XGBoost^7^、CatBoost^9、LightGBM^8^、SVM^39^，以及 H~2~O",
  );
});

test("does not treat an inline bullet operator as a list", () => {
  assert.equal(
    formatTranslationLayout("The similarity is a • b.", "相似度为 a • b。"),
    "相似度为 a • b。",
  );
  assert.equal(
    formatTranslationLayout(
      "• The operator a • b is defined.\n• Report the result.",
      "• 定义运算符 a • b。 • 报告结果。",
    ),
    "• 定义运算符 a • b。\n• 报告结果。",
  );
  assert.equal(
    formatTranslationLayout(
      "• First item\nThe operator a • b is defined.",
      "• 第一项\n算子 a • b 定义如下。",
    ),
    "• 第一项\n算子 a • b 定义如下。",
  );
  assert.equal(
    formatTranslationLayout(
      "• a\n• b\nThe formula is a • b.",
      "• a • b 公式为 a • b。",
    ),
    "• a\n• b 公式为 a • b。",
  );
  assert.equal(
    formatTranslationLayout(
      "• a\n• b\nThe formula is a • b.",
      "• a 公式为 a • b。",
    ),
    "• a 公式为 a • b。",
  );
});

test("does not await paper learning or start per-translation knowledge requests", async () => {
  const source = await readFile(
    new URL("../src/backends/translator.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /if \(request\.context\) schedulePaperLearningAfterTranslation\(request\.context\)/,
  );
  assert.doesNotMatch(source, /await readPreparationRecord\(context\)/);
  assert.doesNotMatch(source, /updateTerminology|TERMINOLOGY_DEVELOPER/);
  assert.doesNotMatch(source, /await ensureCorePaperKnowledge/);
});

test("translates selected text without MinerU Markdown and skips paper learning", async () => {
  const source = await readFile(
    new URL("../src/backends/translator.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /MineruMarkdownUnavailableError/);
  assert.match(source, /buildStandaloneTranslationPrompt/);
  assert.match(
    source,
    /catch\s*\([^)]*\)\s*\{[\s\S]*?MineruMarkdownUnavailableError[\s\S]*?buildStandaloneTranslationPrompt/u,
  );
  let synchronized = false;
  const request = await resolveTranslationRequest(
    {
      attachmentItemID: 42,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      input: "Selected text remains translatable.",
    },
    {
      async prepareContext() {
        throw new MineruMarkdownUnavailableError(
          "not-generated",
          ["_llm_source.json", "full.md", "manifest.json"],
          "E:\\MinerU\\42",
        );
      },
      synchronizeContext() {
        synchronized = true;
      },
    },
  );

  assert.equal(request.context, undefined);
  assert.equal(request.input, "Selected text remains translatable.");
  assert.match(request.prompt, /Text to translate:\nSelected text remains/u);
  assert.doesNotMatch(request.prompt, /Persistent terminology|Paper section/u);
  assert.equal(synchronized, false);
});

test("does not hide paper context validation failures behind text-only translation", async () => {
  const failure = new Error("provenance identity mismatch");
  await assert.rejects(
    resolveTranslationRequest(
      {
        attachmentItemID: 42,
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        input: "Selected text",
      },
      {
        async prepareContext() {
          throw failure;
        },
        synchronizeContext() {
          assert.fail("invalid context must not be synchronized");
        },
      },
    ),
    failure,
  );
});

test("reports a background setup failure without blocking a completed translation", async () => {
  const failure = new Error("preparation record is unavailable");
  let reported: unknown;
  const result = "已完成的译文";

  assert.equal(
    schedulePaperLearningAfterTranslation({} as any, {
      readAttemptId: async () => {
        throw failure;
      },
      continueLearning: async () => {
        assert.fail("learning must not start without a validated attempt");
      },
      monitor: () => {
        assert.fail("a failed setup must not install a monitor");
      },
      report(error) {
        reported = error;
      },
    }),
    undefined,
  );
  assert.equal(result, "已完成的译文");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reported, failure);
});
