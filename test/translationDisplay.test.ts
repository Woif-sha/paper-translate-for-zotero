import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureTranslationDisplayStyles,
  renderTranslationMarkup,
} from "../src/modules/translationDisplay";

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

test("renders multiline translation with XHTML-compatible line breaks", () => {
  const markup = renderTranslationMarkup("第一行\n第二行");

  assert.match(markup, /<br \/>/u);
  assert.doesNotMatch(markup, /<br>/u);
});

test("renders plain sup and sub tags as academic superscripts and subscripts", () => {
  const markup = renderTranslationMarkup(
    "多层感知机（MLPs）<sup>34</sup> 与模式<sub>14</sub>",
  );

  assert.match(markup, /<sup>34<\/sup>/u);
  assert.match(markup, /<sub>14<\/sub>/u);
  assert.doesNotMatch(markup, /&lt;\/?(?:sup|sub)&gt;/u);
});

test("renders paired caret and tilde scripts used in academic text", () => {
  const markup = renderTranslationMarkup("CatBoost^9^ 可表示 H~2~O");

  assert.match(markup, /CatBoost<sup>9<\/sup>/u);
  assert.match(markup, /H<sub>2<\/sub>O/u);
  assert.doesNotMatch(markup, /\^9\^|~2~/u);
});

test("renders single-caret numeric superscripts throughout streaming", () => {
  const incomplete = renderTranslationMarkup("双缝实验^");
  const partial = renderTranslationMarkup("双缝实验^3");
  const complete = renderTranslationMarkup("双缝实验^35中");

  assert.match(incomplete, /双缝实验\^/u);
  assert.match(partial, /双缝实验<sup>3<\/sup>/u);
  assert.match(complete, /双缝实验<sup>35<\/sup>中/u);
  assert.doesNotMatch(complete, /\^35/u);
});

test("does not pair a single numeric caret with later citations", () => {
  const markup = renderTranslationMarkup("CatBoost^9、LightGBM^8^、SVM^39^");

  assert.match(
    markup,
    /CatBoost<sup>9<\/sup>、LightGBM<sup>8<\/sup>、SVM<sup>39<\/sup>/u,
  );
  assert.doesNotMatch(markup, /<sup>[^<]*LightGBM/u);
  assert.doesNotMatch(markup, /\^/u);
});

test("positions scripts without relying on Zotero host styles", () => {
  const style = { id: "", textContent: "" };
  const doc = {
    getElementById: () => null,
    createElementNS: () => style,
    head: { append: (node: unknown) => assert.equal(node, style) },
    documentElement: { append: () => assert.fail("unexpected fallback") },
  } as unknown as Document;

  ensureTranslationDisplayStyles(doc);

  assert.match(
    style.textContent,
    /\.papertranslateforzotero-translation-display sup\s*\{[^}]*vertical-align:\s*super;/su,
  );
  assert.match(
    style.textContent,
    /\.papertranslateforzotero-translation-display sub\s*\{[^}]*vertical-align:\s*sub;/su,
  );
  assert.match(
    style.textContent,
    /\.papertranslateforzotero-translation-display sup,\s*\.papertranslateforzotero-translation-display sub\s*\{[^}]*font-size:\s*0\.75em;[^}]*line-height:\s*0;/su,
  );
});

test("keeps nonnumeric operators and strikethrough out of script parsing", () => {
  const markup = renderTranslationMarkup("x^n，约 ~10%，~~删除~~");

  assert.doesNotMatch(markup, /<sup>|<sub>/u);
  assert.match(markup, /x\^n，约 ~10%，<s>删除<\/s>/u);
});

test("escapes model-provided HTML before displaying translation Markdown", () => {
  const markup = renderTranslationMarkup(
    '<img src="x" onerror="alert(1)"> <sup onclick="alert(1)">34</sup> **安全文本**',
  );

  assert.doesNotMatch(markup, /<img/u);
  assert.doesNotMatch(markup, /<sup onclick/u);
  assert.match(markup, /&lt;img/u);
  assert.match(markup, /&lt;sup onclick/u);
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

test("renders Unicode primes from PDF selections as valid LaTeX", () => {
  const markup = renderTranslationMarkup(
    "静态选主元后的矩阵为 $A′ = PA$（不缩放）或 $A′ = S_rPAS_c$（带缩放）。",
  );

  assert.doesNotMatch(markup, /translation-display-math-error/u);
  assert.equal(markup.match(/<math/gu)?.length, 2);
  assert.match(markup, /<mo[^>]*>′<\/mo>/u);
});
