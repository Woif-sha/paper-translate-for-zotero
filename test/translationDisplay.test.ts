import assert from "node:assert/strict";
import test from "node:test";
import { renderTranslationMarkup } from "../src/modules/translationDisplay";

test("renders Markdown and inline LaTeX without exposing dollar delimiters", () => {
  const markup = renderTranslationMarkup(
    "结果表明，$c_1$ 与 $c_2$ 一致。\n\n- 保留分段\n- 保留列表",
  );

  assert.doesNotMatch(markup, /\$c_[12]\$/u);
  assert.match(markup, /<math/u);
  assert.match(markup, /<msub>/u);
  assert.match(markup, /<ul>/u);
  assert.match(markup, /<li>保留分段<\/li>/u);
});

test("escapes model-provided HTML before displaying translation Markdown", () => {
  const markup = renderTranslationMarkup(
    '<img src="x" onerror="alert(1)"> **安全文本**',
  );

  assert.doesNotMatch(markup, /<img/u);
  assert.match(markup, /&lt;img/u);
  assert.match(markup, /<strong>安全文本<\/strong>/u);
});

test("does not create executable links from untrusted translation Markdown", () => {
  const markup = renderTranslationMarkup(
    "[不可信链接](javascript:alert(document.domain))\n\n![远程图片](https://example.com/tracker.png)",
  );

  assert.doesNotMatch(markup, /href=/u);
  assert.doesNotMatch(markup, /<script|<img|src=/u);
});

test("marks invalid closed LaTeX visibly without exposing its delimiters", () => {
  const markup = renderTranslationMarkup("结果为 $\\unknownCommand{x}$。");

  assert.match(markup, /translation-display-math-error/u);
  assert.match(markup, /\\unknownCommand\{x\}/u);
  assert.doesNotMatch(markup, /\$\\unknownCommand/u);
});
