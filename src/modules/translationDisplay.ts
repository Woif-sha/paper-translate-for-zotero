import MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import katex from "katex";
import { config } from "../../package.json";

const DISPLAY_CLASS = `${config.addonRef}-translation-display`;
const PLACEHOLDER_CLASS = `${DISPLAY_CLASS}-placeholder`;
const MATH_ERROR_CLASS = `${DISPLAY_CLASS}-math-error`;
const STYLE_ID = `${config.addonRef}-translation-display-style`;

const markdown = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: false,
  typographer: false,
  xhtmlOut: true,
});

markdown.disable(["image", "link"]);
markdown.inline.ruler.before("escape", "translation_script", parseScript);
markdown.inline.ruler.before("escape", "translation_math", parseMath);
markdown.renderer.rules.translation_script = (tokens, index) => {
  const token = tokens[index];
  const tag = token.tag === "sub" ? "sub" : "sup";
  return `<${tag}>${escapeHtml(token.content)}</${tag}>`;
};
markdown.renderer.rules.translation_math = (tokens, index) => {
  const token = tokens[index];
  return renderMath(token.content, token.markup === "$$");
};

export function renderTranslationMarkup(value: string): string {
  return markdown.render(value);
}

export function renderTranslationDisplay(
  container: HTMLElement,
  value: string,
  placeholder: string,
): void {
  ensureTranslationDisplayStyles(container.ownerDocument);
  const wasAtBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight <= 2;
  if (value) {
    container.innerHTML = renderTranslationMarkup(value);
  } else {
    const placeholderNode = container.ownerDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "span",
    );
    placeholderNode.className = PLACEHOLDER_CLASS;
    placeholderNode.textContent = placeholder;
    container.replaceChildren(placeholderNode);
  }
  if (wasAtBottom) container.scrollTop = container.scrollHeight;
}

export function ensureTranslationDisplayStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "style",
  ) as HTMLStyleElement;
  style.id = STYLE_ID;
  style.textContent = `
    .${DISPLAY_CLASS} p { margin: 0 0 0.55em; }
    .${DISPLAY_CLASS} p:last-child { margin-bottom: 0; }
    .${DISPLAY_CLASS} ul,
    .${DISPLAY_CLASS} ol { margin: 0 0 0.55em; padding-inline-start: 1.6em; }
    .${DISPLAY_CLASS} li + li { margin-top: 0.2em; }
    .${DISPLAY_CLASS} pre { margin: 0 0 0.55em; white-space: pre-wrap; }
    .${DISPLAY_CLASS} code { font-family: monospace; }
    .${DISPLAY_CLASS} sup,
    .${DISPLAY_CLASS} sub { font-size: 0.75em; line-height: 0; }
    .${DISPLAY_CLASS} sup { vertical-align: super; }
    .${DISPLAY_CLASS} sub { vertical-align: sub; }
    .${DISPLAY_CLASS} math[display="block"] { margin: 0.4em 0; overflow-x: auto; }
    .${PLACEHOLDER_CLASS} { color: var(--fill-secondary); }
    .${MATH_ERROR_CLASS} {
      color: var(--color-red-70, #b3261e);
      text-decoration: underline dotted;
      text-underline-offset: 0.15em;
    }
  `;
  (doc.head || doc.documentElement).append(style);
}

function parseScript(state: StateInline, silent: boolean): boolean {
  const source = state.src.slice(state.pos);
  const htmlMatch = /^<(sup|sub)>([^<>\r\n]+)<\/\1>/u.exec(source);
  let tag: "sup" | "sub";
  let content: string;
  let length: number;
  if (htmlMatch) {
    tag = htmlMatch[1] as "sup" | "sub";
    content = htmlMatch[2];
    length = htmlMatch[0].length;
  } else {
    const marker = state.src[state.pos];
    if (
      (marker !== "^" && marker !== "~") ||
      isEscaped(state.src, state.pos) ||
      state.src[state.pos - 1] === marker ||
      state.src[state.pos + 1] === marker
    ) {
      return false;
    }
    const end = findClosingScriptMarker(state.src, state.pos + 1, marker);
    if (end < 0) return false;
    content = state.src.slice(state.pos + 1, end);
    if (!content || /[\s<>]/u.test(content)) return false;
    tag = marker === "^" ? "sup" : "sub";
    length = end - state.pos + 1;
  }
  if (!silent) {
    const token = state.push("translation_script", tag, 0);
    token.content = content;
  }
  state.pos += length;
  return true;
}

function findClosingScriptMarker(
  value: string,
  start: number,
  marker: "^" | "~",
): number {
  let position = start;
  while (position < value.length) {
    position = value.indexOf(marker, position);
    if (position < 0) return -1;
    if (
      !isEscaped(value, position) &&
      value[position - 1] !== marker &&
      value[position + 1] !== marker
    ) {
      return position;
    }
    position += 1;
  }
  return -1;
}

function parseMath(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src[start] !== "$" || isEscaped(state.src, start)) return false;
  const delimiter = state.src[start + 1] === "$" ? "$$" : "$";
  const contentStart = start + delimiter.length;
  const end = findClosingDelimiter(state.src, contentStart, delimiter);
  if (end < 0) return false;
  const content = state.src.slice(contentStart, end);
  if (!content || /^\s|\s$/u.test(content)) return false;
  if (!silent) {
    const token = state.push("translation_math", "math", 0);
    token.content = content;
    token.markup = delimiter;
  }
  state.pos = end + delimiter.length;
  return true;
}

function findClosingDelimiter(
  value: string,
  start: number,
  delimiter: "$" | "$$",
): number {
  let position = start;
  while (position < value.length) {
    position = value.indexOf(delimiter, position);
    if (position < 0) return -1;
    if (!isEscaped(value, position)) return position;
    position += delimiter.length;
  }
  return -1;
}

function isEscaped(value: string, position: number): boolean {
  let slashCount = 0;
  for (let index = position - 1; index >= 0 && value[index] === "\\"; index--) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function renderMath(value: string, displayMode: boolean): string {
  try {
    return katex.renderToString(value, {
      displayMode,
      output: "mathml",
      maxExpand: 1_000,
      maxSize: 10,
      strict: "error",
      throwOnError: true,
      trust: false,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `<span class="${MATH_ERROR_CLASS}" title="${escapeHtml(detail)}">${escapeHtml(value)}</span>`;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}
