import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { formatTranslationLayout } from "../src/backends/translator";

test("keeps translated bullet items on separate lines", () => {
  assert.equal(
    formatTranslationLayout(
      "  • First item\n  • Second item",
      "• 第一项 • 第二项",
    ),
    "• 第一项\n• 第二项",
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
  assert.match(source, /const learning = continuePaperLearning\(context\)/);
  assert.match(source, /monitorReaderSidebarLearning\(context, learning\)/);
  assert.doesNotMatch(source, /updateTerminology|TERMINOLOGY_DEVELOPER/);
  assert.doesNotMatch(source, /await ensureCorePaperKnowledge/);
});
