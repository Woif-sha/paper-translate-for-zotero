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

test("preserves scientific subscripts that share a citation number", () => {
  const sources = [
    "The concentration of H₂O is measured.<sup>2</sup>",
    "The concentration of H<sub>2</sub>O is measured.<sup>2</sup>",
    "The concentration of H2O is measured.<sup>2</sup>",
    "The coefficient $c_2$ is measured.<sup>2</sup>",
  ];
  for (const source of sources) {
    for (const translation of ["H₂O。²", "H~2~O。²", "H<sub>2</sub>O。²"]) {
      assert.equal(formatTranslationLayout(source, translation), translation);
    }
  }
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

test("schedules one knowledge job without waiting for its completion", async () => {
  const learning = new Promise<void>(() => undefined);
  const calls: string[] = [];
  const context = {} as any;
  assert.equal(
    schedulePaperLearningAfterTranslation(context, {
      async readAttemptId(value) {
        assert.equal(value, context);
        calls.push("attempt");
        return 2;
      },
      continueLearning(value) {
        assert.equal(value, context);
        calls.push("learning");
        return learning;
      },
      monitor(value, operation, attemptId) {
        assert.equal(value, context);
        assert.equal(operation, learning);
        assert.equal(attemptId, 2);
        calls.push("monitor");
      },
      report: assert.fail,
    }),
    undefined,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["attempt", "learning", "monitor"]);
});

test("keeps UI module dependencies out of the translation backend", async () => {
  const source = await readFile(
    new URL("../src/backends/translator.ts", import.meta.url),
    "utf8",
  );
  assert.equal(/from ["']\.\.\/modules\//u.test(source), false);
});

test("translates selected text without MinerU Markdown and skips paper learning", async () => {
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
    },
  );

  assert.equal(request.context, undefined);
  assert.equal(request.input, "Selected text remains translatable.");
  assert.match(request.prompt, /Text to translate:\nSelected text remains/u);
  assert.doesNotMatch(request.prompt, /Persistent terminology|Paper section/u);
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

test("reports a knowledge job failure when no UI observer is attached", async () => {
  const failure = new Error("knowledge request failed");
  let reported: unknown;
  schedulePaperLearningAfterTranslation({} as any, {
    readAttemptId: async () => 2,
    continueLearning: () => Promise.reject(failure),
    report(error) {
      reported = error;
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reported, failure);
});
