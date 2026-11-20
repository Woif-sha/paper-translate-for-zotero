import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import { configureSafeMath } from "../modules/translationDisplay";

export type TranslationUnit = {
  id: string;
  text: string;
  protectedParts: string[];
};
type Inline = { index: number; units: TranslationUnit[] };
type Block = { tokens: Token[]; line: number; translations: Inline[] };
export type FulltextDocument = {
  blocks: Block[];
  units: TranslationUnit[];
  imagePaths: Set<string>;
  references?: object;
};
export type FulltextFigure = { path: string; label: string; line?: number };

const markerPattern = /⟦PT:(\d+)⟧/gu;
const literals =
  /(?<!\\)\$\$[\s\S]+?(?<!\\)\$\$|(?<!\\)\$(?!\$)[^\r\n$]+?(?<!\\)\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]|\\begin\{([a-zA-Z*]+)\}[\s\S]+?\\end\{\1\}|(\x60+)[\s\S]+?\2|!?\[[^\]\n]*\]\((?:[^()\n]|\([^()\n]*\))*\)|!?\[[^\]\n]+\]\[[^\]\n]*\]|<\/?[a-z][^<>\n]*>|https?:\/\/[^\s<>]+|10\.\d{4,9}\/[^\s<>"\]]+|\[(?:\s*\d+[,\s;–-]*)+\]|\b(?:fig(?:ure)?s?|tables?|eq(?:uation)?s?)\.?\s+\(?[A-Z]?\d+(?:[.\d]+)?[a-z]?\)?|[-−+]?\d+(?:[.,]\d+)*(?:[eE][+-]?\d+)?(?:[ \u00a0]*(?:GPa|MPa|kPa|Pa|GHz|MHz|kHz|Hz|mm|cm|km|µm|μm|nm|kg|°C|m\/s|N·m)\b|[%°])?/giu;

type RenderEnv = { assets: ReadonlyMap<string, string>; references?: object };
const markdown = new MarkdownIt({ html: true, linkify: false });
configureSafeMath(markdown);
const escapeHtml = markdown.utils.escapeHtml;
markdown.renderer.rules.html_inline = (tokens, i) =>
  escapeHtml(tokens[i].content);
markdown.renderer.rules.html_block = (tokens, i) =>
  renderSourceHtml(tokens[i].content);
markdown.renderer.rules.image = (tokens, i, _options, env: RenderEnv) =>
  renderImage(
    normalizeImageReference(tokens[i].attrGet("src") ?? ""),
    tokens[i].content,
    env.assets,
  );
markdown.renderer.rules.link_open = (tokens, i, options, _env, renderer) =>
  /^https?:\/\//iu.test(tokens[i].attrGet("href") ?? "")
    ? renderer.renderToken(tokens, i, options)
    : "<a>";

export function parseFulltext(source: string): FulltextDocument {
  const env: RenderEnv = { assets: new Map() };
  const tokens = markdown.parse(source, env);
  const blocks: Block[] = [];
  const imagePaths = new Set<string>();
  const units: TranslationUnit[] = [];
  let referenceLevel: number | undefined;
  for (let start = 0; start < tokens.length; ) {
    let end = start + 1;
    for (
      let depth = tokens[start].nesting;
      depth > 0 && end < tokens.length;
      end++
    ) {
      depth += tokens[end].nesting;
    }
    const group = tokens.slice(start, end);
    const block: Block = {
      tokens: group,
      line: group[0].map?.[0] ?? 0,
      translations: [],
    };
    if (group[0].type === "heading_open") {
      const level = Number(group[0].tag.slice(1));
      if (referenceLevel !== undefined && level <= referenceLevel)
        referenceLevel = undefined;
      if (
        /^(?:references|bibliography|literature cited|works cited|参考文献)$/iu.test(
          group[1]?.content.trim(),
        )
      )
        referenceLevel = level;
    }
    for (const [index, token] of group.entries()) {
      if (token.type !== "inline") continue;
      token.children = parseInline(token.content, env);
      for (const child of token.children) {
        if (child.type === "image")
          imagePaths.add(normalizeImageReference(child.attrGet("src") ?? ""));
      }
      if (referenceLevel !== undefined || group[0].type === "table_open")
        continue;
      const parts = createUnits(
        token.content,
        "b" + (start + 1) + "i" + (index + 1),
      );
      if (parts.length) {
        block.translations.push({ index, units: parts });
        units.push(...parts);
      }
    }
    blocks.push(block);
    start = end;
  }
  return { blocks, units, imagePaths, references: env.references };
}

function parseInline(value: string, env: object): Token[] {
  const normalized = value.replace(literals, (match) => {
    if (match.startsWith("\\(") && match.endsWith("\\)"))
      return "$" + match.slice(2, -2).trim() + "$";
    if (match.startsWith("\\[") && match.endsWith("\\]"))
      return "$$" + match.slice(2, -2).trim() + "$$";
    if (match.startsWith("\\begin{")) return "$$" + match + "$$";
    return match;
  });
  return markdown.parseInline(normalized, env)[0].children ?? [];
}

function marker(index: number): string {
  return "⟦PT:" + index + "⟧";
}

function createUnits(value: string, id: string): TranslationUnit[] {
  if (value.includes("⟦PT:"))
    throw new Error("源 Markdown 包含保留的全文翻译标记");
  const protectedParts: string[] = [];
  const masked = value.replace(literals, (part) =>
    marker(protectedParts.push(part) - 1),
  );
  if (!/\p{L}/u.test(masked.replace(markerPattern, ""))) return [];
  const chunks: string[] = [];
  let current = "";
  for (const piece of masked.match(/⟦PT:\d+⟧|[^\s⟦]+|[\s\S]/gu) ?? []) {
    if (piece.length > 1400)
      throw new Error(
        "Markdown contains an unbroken token too long to translate",
      );
    if (
      current &&
      (current.length + piece.length > 1400 ||
        (current.length >= 1000 && /[.!?。！？]\s$/u.test(current)))
    ) {
      chunks.push(current);
      current = "";
    }
    current += piece;
  }
  if (current.trim()) chunks.push(current);
  return chunks.map((text, index) => {
    const parts: string[] = [];
    const local = text.replace(markerPattern, (_match, digit) =>
      marker(parts.push(protectedParts[Number(digit)]) - 1),
    );
    return {
      id: id + "p" + (index + 1),
      text: local.trim(),
      protectedParts: parts,
    };
  });
}

export function restoreTranslation(
  unit: TranslationUnit,
  result: string,
): string {
  const text = result.trim();
  if (!text || text.length > 6000)
    throw new Error("译文为空或超过单段长度限制");
  const expectedText = /[a-z]{2}|\p{Script=Han}/u.test(
    unit.text.replace(markerPattern, ""),
  );
  const seen = new Set<number>();
  const remaining = text.replace(markerPattern, (match, digit) => {
    const index = Number(digit);
    if (
      match !== marker(index) ||
      index >= unit.protectedParts.length ||
      seen.has(index)
    )
      throw new Error("译文中的公式、数字或链接标记无效");
    seen.add(index);
    return "";
  });
  if (
    remaining.includes("⟦PT:") ||
    seen.size !== unit.protectedParts.length ||
    (expectedText && !/\p{Script=Han}/u.test(remaining))
  )
    throw new Error("译文缺少中文正文或原文标记");
  return text.replace(
    markerPattern,
    (_match, digit) => unit.protectedParts[Number(digit)],
  );
}

export function renderFulltext(
  document: FulltextDocument,
  results: ReadonlyMap<string, string>,
  options: {
    title: string;
    model: string;
    assets: ReadonlyMap<string, string>;
    figures?: FulltextFigure[];
  },
): string {
  const env: RenderEnv = {
    assets: options.assets,
    references: document.references,
  };
  const sections: string[] = [];
  const placed = new Map<number, FulltextFigure[]>();
  for (const figure of options.figures ?? []) {
    if (document.imagePaths.has(figure.path)) continue;
    const line = figure.line;
    const next =
      line === undefined
        ? -1
        : document.blocks.findIndex((block) => block.line > line);
    const index = next === -1 ? document.blocks.length : next;
    const figures = placed.get(index) ?? [];
    figures.push(figure);
    placed.set(index, figures);
  }
  const renderFigures = (index: number) => {
    for (const figure of placed.get(index) ?? []) {
      sections.push(
        "<figure>" +
          renderImage(figure.path, figure.label, options.assets) +
          "</figure>",
      );
    }
  };
  for (const [index, block] of document.blocks.entries()) {
    renderFigures(index);
    const english = markdown.renderer.render(
      block.tokens,
      markdown.options,
      env,
    );
    const tag = '<section data-block-id="' + (index + 1) + '">';
    if (!block.translations.length) {
      sections.push(tag + english + "</section>");
      continue;
    }
    const translated = block.tokens.slice();
    for (const inline of block.translations) {
      const token = translated[inline.index];
      const content = inline.units
        .map((unit) => restoreTranslation(unit, results.get(unit.id) ?? ""))
        .join(" ");
      translated[inline.index] = {
        ...token,
        content,
        children: parseInline(content, env),
      } as Token;
    }
    const zh = markdown.renderer.render(translated, markdown.options, env);
    sections.push(
      tag +
        '<div class="en" lang="en">' +
        english +
        '</div><div class="zh" lang="zh-CN">' +
        zh +
        "</div></section>",
    );
  }
  renderFigures(document.blocks.length);
  const title = escapeHtml(options.title);
  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; img-src data:; style-src &#39;unsafe-inline&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;">' +
    "<title>" +
    title +
    "</title><style>" +
    "html{color-scheme:light dark}body{font:17px/1.65 system-ui,sans-serif;margin:2rem auto;max-width:1000px;padding:0 1rem}" +
    "section{margin:1rem 0}section:has(>.zh){border-bottom:1px solid #8885}.zh{margin:.45rem 0 .8rem}img{max-width:100%;height:auto}" +
    "table{border-collapse:collapse;display:block;overflow:auto}td,th{padding:.25rem .55rem;border:1px solid #8888}" +
    "pre{white-space:pre-wrap}math[display=block]{overflow:auto}.missing{border:1px dashed #888;padding:.4rem}" +
    "body:has(#mode-zh:checked) .en,body:has(#mode-en:checked) .zh{display:none}label{margin-right:1rem}" +
    "</style></head><body><header><h1>" +
    title +
    "</h1><p>翻译模型：" +
    escapeHtml(options.model) +
    "</p></header>" +
    "<fieldset><legend>阅读模式</legend>" +
    '<label><input type="radio" name="mode" checked id="mode-bi"> 双语</label>' +
    '<label><input type="radio" name="mode" id="mode-zh"> 只看中文</label>' +
    '<label><input type="radio" name="mode" id="mode-en"> 只看原文</label>' +
    "</fieldset><main>" +
    sections.join("\n") +
    "</main></body></html>"
  );
}

export function normalizeImageReference(path: string): string {
  try {
    return decodeURIComponent(path).replace(/\\/gu, "/").replace(/^\.\//u, "");
  } catch {
    return "";
  }
}

function renderImage(
  path: string,
  label: string,
  assets: ReadonlyMap<string, string>,
): string {
  const description = escapeHtml(label || "图像");
  const data = assets.get(path);
  return data &&
    /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/u.test(data)
    ? '<img alt="' + description + '" src="' + data + '">'
    : '<span class="missing">图片资源不可用 · ' + description + "</span>";
}

function renderSourceHtml(value: string): string {
  if (!/^\s*<table(?:\s[^>]*)?>[\s\S]*<\/table>\s*$/iu.test(value))
    return "<pre>" + escapeHtml(value) + "</pre>";
  const allowed = /^(?:table|thead|tbody|tfoot|tr|th|td|caption|br|sup|sub)$/u;
  return (value.match(/<[^>]*>|[^<]+|</gu) ?? [])
    .map((part) => {
      const match = /^<(\/?)([a-z]+)(?:\s[^>]*)?\/?>$/iu.exec(part);
      if (!match || !allowed.test(match[2].toLowerCase()))
        return escapeHtml(markdown.utils.unescapeAll(part));
      const tag = match[2].toLowerCase();
      const spans =
        tag === "td" || tag === "th"
          ? (
              part.match(
                /\b(?:rowspan|colspan)=["']?[1-9]\d?["']?(?=\s|\/?>)/giu,
              ) ?? []
            )
              .map((attribute) => " " + attribute.replace(/["']/gu, ""))
              .join("")
          : "";
      return "<" + match[1] + tag + (match[1] ? "" : spans) + ">";
    })
    .join("");
}
