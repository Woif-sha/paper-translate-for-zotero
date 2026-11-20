import {
  createDefaultMineruImageFileAccess,
  readContainedMineruRaster,
} from "../ocr/mineruImages";
import type { readValidatedMineruSource } from "../context/runtime";
import { normalizeImageReference, type FulltextFigure } from "./document";

type Source = Awaited<ReturnType<typeof readValidatedMineruSource>>;

export function resolveFulltextFigures(
  manifest: Source["manifest"],
  markdown: string,
): FulltextFigure[] {
  const metadata = manifest as {
    allFigures?: unknown;
    figureBlocks?: unknown;
  };
  const figures = new Map<string, FulltextFigure>();
  if (Array.isArray(metadata.allFigures)) {
    for (const figure of metadata.allFigures) {
      if (!figure || typeof figure.path !== "string" || !figure.path.trim())
        continue;
      const path = normalizeImageReference(figure.path);
      if (!path || figures.has(path)) continue;
      figures.set(path, {
        path,
        label: typeof figure.label === "string" ? figure.label : "",
      });
    }
  }
  const lines = markdown.split(/\r\n?|\n/u);
  const positions = new Map<string, number | undefined>();
  const pending: string[] = [];
  let previousEnd: number | undefined;
  for (const block of Array.isArray(metadata.figureBlocks)
    ? metadata.figureBlocks
    : []) {
    if (!block || !Array.isArray(block.imagePaths)) {
      pending.length = 0;
      previousEnd = undefined;
      continue;
    }
    const paths = block.imagePaths.flatMap((value: unknown) => {
      if (typeof value !== "string") return [];
      const path = normalizeImageReference(value);
      return path ? [path] : [];
    }) as string[];
    const label = Array.isArray(block.labelHints)
      ? block.labelHints.find(
          (value: unknown): value is string =>
            typeof value === "string" && !!value.trim(),
        )
      : undefined;
    for (const path of paths) {
      if (!figures.has(path)) figures.set(path, { path, label: label ?? "" });
    }
    const start = block.markdownStart;
    const end = block.markdownEnd;
    if (
      previousEnd === undefined ||
      !Number.isInteger(start) ||
      start < previousEnd ||
      start - previousEnd > 4
    )
      pending.length = 0;
    previousEnd = Number.isInteger(block.contextEnd)
      ? block.contextEnd
      : undefined;
    if (block.ambiguous) {
      pending.length = 0;
      continue;
    }
    const hasSourceEmbed =
      Number.isInteger(start) &&
      Number.isInteger(end) &&
      start >= 0 &&
      paths.some((path) => markdown.slice(start, end).includes(path));
    const matches = label
      ? lines.flatMap((line, index) =>
          line.trim().startsWith(label + ":") ||
          line.trim().startsWith(label + ". ")
            ? [index]
            : [],
        )
      : [];
    const line =
      matches.length === 1
        ? matches[0]
        : hasSourceEmbed
          ? markdown.slice(0, start).split(/\r\n?|\n/u).length - 1
          : undefined;
    if (line !== undefined) {
      for (const path of [...pending, ...paths]) {
        positions.set(
          path,
          positions.has(path) && positions.get(path) !== line
            ? undefined
            : line,
        );
      }
      pending.length = 0;
    } else if (!label) {
      pending.push(...paths);
    } else {
      pending.length = 0;
    }
  }
  return [...figures.values()].map((figure) => ({
    ...figure,
    line: positions.get(figure.path),
  }));
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
