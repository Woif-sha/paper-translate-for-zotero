import {
  createDefaultMineruImageFileAccess,
  readContainedMineruRaster,
  requireContainedFile,
} from "../ocr/mineruImages";
import type { readValidatedMineruSource } from "../context/runtime";
import { normalizeImageReference, type FulltextFigure } from "./document";

type Source = Awaited<ReturnType<typeof readValidatedMineruSource>>;
type Anchor = { line: number; label: string };
type CachedFigure = { path?: unknown; label?: unknown; caption?: unknown };
type FigureBlock = {
  imagePaths?: unknown;
  markdownStart?: number;
  markdownEnd?: number;
  contextEnd?: number;
  labelHints?: unknown;
  captionHints?: unknown;
  ambiguous?: boolean;
};
type VisualEntry = {
  path: string;
  page: number | undefined;
  box: number[];
  index: number;
};

const FIGURE_NUMBER = /^fig(?:ure)?\.?\s*([a-z]*\d+(?:[.-]\d+)*[a-z]?)\b/iu;
const CAPTION_SEPARATOR = /^\s*(?:[:|：｜]|\.(?:\s|$))/u;

export async function readFulltextFigureMetadata(
  cacheDirectory: string,
): Promise<unknown[]> {
  const separator = cacheDirectory.includes("\\") ? "\\" : "/";
  const path = cacheDirectory + separator + "content_list.json";
  if (!(await IOUtils.exists(path))) return [];
  const access = createDefaultMineruImageFileAccess();
  const file = await requireContainedFile(
    await access.canonicalize(cacheDirectory),
    path,
    access,
  );
  const limit = 32 * 1024 * 1024;
  const { size } = await access.stat(file);
  if (!size || size > limit)
    throw new Error("MinerU 图块清单为空或超出大小限制");
  const bytes = await access.read(file);
  if (bytes.byteLength > limit) throw new Error("MinerU 图块清单超出大小限制");
  const metadata: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (!Array.isArray(metadata)) throw new Error("MinerU 图块清单格式无效");
  return metadata;
}

export function resolveFulltextFigures(
  manifest: Source["manifest"],
  markdown: string,
  content: unknown[] = [],
): FulltextFigure[] {
  const metadata = manifest as {
    allFigures?: CachedFigure[];
    figureBlocks?: FigureBlock[];
  };
  const figures = new Map<string, FulltextFigure>();
  const findAnchor = createCaptionLocator(markdown);
  for (const figure of Array.isArray(metadata.allFigures)
    ? metadata.allFigures
    : []) {
    const path = normalizePath(figure?.path);
    if (!path || figures.has(path)) continue;
    const label = typeof figure.label === "string" ? figure.label : "";
    const anchor = findAnchor([figure.caption], [label]);
    figures.set(path, {
      path,
      label: anchor?.label ?? label,
      line: anchor?.line,
    });
  }
  // Older caches can still place single-caption groups using the manifest alone.
  const pending: string[] = [];
  let previousEnd: number | undefined;
  for (const block of Array.isArray(metadata.figureBlocks)
    ? metadata.figureBlocks
    : []) {
    const paths = Array.isArray(block?.imagePaths)
      ? block.imagePaths.map(normalizePath).filter(Boolean)
      : [];
    const captions = Array.isArray(block?.captionHints)
      ? block.captionHints
      : [];
    const labels = Array.isArray(block?.labelHints) ? block.labelHints : [];
    const displayLabel =
      labels.length === 1 && typeof labels[0] === "string" ? labels[0] : "";
    for (const path of paths)
      if (!figures.has(path)) figures.set(path, { path, label: displayLabel });
    const start = block?.markdownStart;
    const end = block?.markdownEnd;
    if (
      previousEnd === undefined ||
      typeof start !== "number" ||
      !Number.isInteger(start) ||
      start < previousEnd ||
      start - previousEnd > 4
    )
      pending.length = 0;
    previousEnd = Number.isInteger(block?.contextEnd)
      ? block.contextEnd
      : undefined;
    if (block?.ambiguous || !paths.length) {
      pending.length = 0;
      continue;
    }
    const anchor = findAnchor(captions, labels);
    if (anchor) {
      for (const path of [...pending, ...paths]) {
        const figure = figures.get(path)!;
        if (figure.line === undefined) figures.set(path, { path, ...anchor });
      }
      pending.length = 0;
    } else if (labels.length || captions.length) {
      pending.length = 0;
    } else {
      pending.push(...paths);
    }
    if (
      typeof start === "number" &&
      typeof end === "number" &&
      Number.isInteger(start) &&
      Number.isInteger(end) &&
      start >= 0 &&
      end > start &&
      end <= markdown.length
    ) {
      const slice = markdown.slice(start, end);
      for (const path of paths) {
        const figure = figures.get(path)!;
        if (figure.line === undefined && slice.includes(path))
          figure.line = markdown.slice(0, start).split(/\r\n?|\n/u).length - 1;
      }
    }
  }
  const visualAnchors = resolveVisualAnchors(figures, content, findAnchor);
  return [
    ...Array.from(visualAnchors, ([path, anchor]) => ({ path, ...anchor })),
    ...Array.from(figures.values()).filter(
      (figure) => !visualAnchors.has(figure.path),
    ),
  ];
}

function createCaptionLocator(markdown: string) {
  const exact = new Map<string, number[]>();
  const byNumber = new Map<string, number[]>();
  for (const [line, text] of markdown.split(/\r\n?|\n/u).entries()) {
    const normalized = normalizeCaption(text);
    const figure = FIGURE_NUMBER.exec(normalized);
    if (!figure) continue;
    addLine(exact, normalized, line);
    if (CAPTION_SEPARATOR.test(normalized.slice(figure[0].length)))
      addLine(byNumber, figure[1].toUpperCase(), line);
  }
  return (captions: unknown[], labels: unknown[] = []): Anchor | undefined => {
    const anchors = new Map<number, Anchor>();
    const numbers = new Set<string>();
    for (const value of [...captions, ...labels]) {
      if (typeof value !== "string") continue;
      const caption = normalizeCaption(value);
      const number = FIGURE_NUMBER.exec(caption)?.[1].toUpperCase();
      if (!number) continue;
      numbers.add(number);
      const lines = exact.get(caption) ?? byNumber.get(number);
      if (lines?.length === 1)
        anchors.set(lines[0], { line: lines[0], label: "Figure " + number });
    }
    return numbers.size === 1 && anchors.size === 1
      ? anchors.values().next().value
      : undefined;
  };
}

function addLine(
  index: Map<string, number[]>,
  key: string,
  line: number,
): void {
  const matches = index.get(key);
  if (matches) matches.push(line);
  else index.set(key, [line]);
}

function normalizeCaption(caption: string): string {
  return caption
    .replaceAll("\0", " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^\*{1,3}/u, "");
}

function normalizePath(value: unknown): string {
  return typeof value === "string" ? normalizeImageReference(value.trim()) : "";
}

function resolveVisualAnchors(
  figures: Map<string, FulltextFigure>,
  content: unknown[],
  findAnchor: ReturnType<typeof createCaptionLocator>,
): Map<string, Anchor> {
  const pending: VisualEntry[] = [];
  const placed = new Map<string, Anchor>();
  for (const [index, value] of content.entries()) {
    if (!value || typeof value !== "object") continue;
    const raw = value as Record<string, unknown>;
    if (raw.type === "table") pending.length = 0;
    if (raw.type !== "image" && raw.type !== "chart") continue;
    const path = normalizePath(raw.img_path);
    if (!figures.has(path)) {
      pending.length = 0;
      continue;
    }
    const entry: VisualEntry = {
      path,
      page:
        typeof raw.page_idx === "number" && Number.isInteger(raw.page_idx)
          ? raw.page_idx
          : undefined,
      box:
        Array.isArray(raw.bbox) &&
        raw.bbox.length === 4 &&
        raw.bbox.every(Number.isFinite)
          ? raw.bbox
          : [],
      index,
    };
    const previous = pending.at(-1);
    if (
      previous &&
      (entry.page === undefined ||
        entry.page !== previous.page ||
        (index !== previous.index + 1 &&
          !panelsShareRow(previous.box, entry.box)))
    )
      pending.length = 0;
    const rawCaptions =
      raw.type === "chart" ? raw.chart_caption : raw.image_caption;
    const captions = (Array.isArray(rawCaptions) ? rawCaptions : []).filter(
      (caption): caption is string =>
        typeof caption === "string" &&
        FIGURE_NUMBER.test(normalizeCaption(caption)),
    );
    if (!captions.length) {
      pending.push(entry);
      continue;
    }
    const anchor = findAnchor(captions);
    if (anchor) {
      for (const panel of [...pending, entry]) placed.set(panel.path, anchor);
    }
    // A numbered caption closes this group even when it could not be located.
    pending.length = 0;
  }
  return placed;
}

function panelsShareRow(first: number[], second: number[]): boolean {
  if (first.length !== 4 || second.length !== 4) return false;
  const overlap = Math.min(first[3], second[3]) - Math.max(first[1], second[1]);
  const shortest = Math.min(first[3] - first[1], second[3] - second[1]);
  return (
    shortest > 0 &&
    overlap >= shortest * 0.8 &&
    (first[2] <= second[0] || second[2] <= first[0])
  );
}

export async function loadFulltextAssets(
  cacheDirectory: string,
  paths: Iterable<string>,
  signal: AbortSignal,
): Promise<Map<string, string>> {
  const fileAccess = createDefaultMineruImageFileAccess();
  const assets = new Map<string, string>();
  let remaining = 24 * 1024 * 1024;
  for (const path of new Set(paths)) {
    signal.throwIfAborted();
    if (!remaining) break;
    const image = await readContainedMineruRaster(
      cacheDirectory,
      path,
      Math.min(remaining, 4 * 1024 * 1024),
      fileAccess,
    );
    if (!image) continue;
    remaining -= image.size;
    assets.set(path, image.dataUrl);
  }
  return assets;
}
