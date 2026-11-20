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
  const positions = new Map<string, number | undefined>();
  if (Array.isArray(metadata.figureBlocks)) {
    for (const block of metadata.figureBlocks) {
      if (
        !block ||
        block.ambiguous ||
        !Array.isArray(block.imagePaths) ||
        !Number.isInteger(block.markdownStart) ||
        block.markdownStart < 0 ||
        block.markdownStart >= markdown.length
      )
        continue;
      const line =
        markdown.slice(0, block.markdownStart).split(/\r\n?|\n/u).length - 1;
      for (const rawPath of block.imagePaths) {
        if (typeof rawPath !== "string") continue;
        const path = normalizeImageReference(rawPath);
        if (!figures.has(path)) continue;
        positions.set(
          path,
          positions.has(path) && positions.get(path) !== line
            ? undefined
            : line,
        );
      }
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
