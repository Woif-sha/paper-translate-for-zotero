import {
  MineruMarkdownUnavailableError,
  readValidatedMineruSource,
  withFulltextPaperDirectory,
} from "../context/runtime";
import { getActiveModelSnapshot } from "../models/runtime";
import {
  createDefaultMineruImageFileAccess,
  sha256Hex,
} from "../ocr/mineruImages";
import {
  loadFulltextAssets,
  readFulltextFigureMetadata,
  resolveFulltextFigures,
} from "./assets";
import { parseFulltext, renderFulltext } from "./document";
import { FULLTEXT_PROMPT_VERSION, translateFulltextUnits } from "./translation";

type Status = {
  phase: "source" | "translating" | "output";
  model: string;
  done?: number;
  total?: number;
};
type Source = Awaited<ReturnType<typeof readValidatedMineruSource>>;
type ActiveJob = {
  attachmentId: number;
  controller: AbortController;
  promise: Promise<Zotero.Item>;
};
let activeJob: ActiveJob | undefined;

export function isFulltextRunning(attachmentId: number): boolean {
  return (
    activeJob?.attachmentId === attachmentId &&
    !activeJob.controller.signal.aborted
  );
}

export function pauseFulltext(attachmentId: number): void {
  if (activeJob?.attachmentId === attachmentId)
    activeJob.controller.abort(new Error("全文翻译已暂停"));
}

export async function stopFulltext(): Promise<void> {
  const job = activeJob;
  if (!job) return;
  pauseFulltext(job.attachmentId);
  // The initiating UI reports failures. Wait here so teardown cannot race a checkpoint write.
  await job.promise.catch(() => undefined);
}

export async function startFulltext(
  attachmentId: number,
  progress: (status: Status) => void,
): Promise<Zotero.Item> {
  if (
    activeJob?.attachmentId === attachmentId &&
    activeJob.controller.signal.aborted
  ) {
    await activeJob.promise.catch(() => undefined);
  }
  if (activeJob) throw new Error("已有一篇论文正在全文翻译");
  const controller = new AbortController();
  const promise = runFulltext(attachmentId, progress, controller.signal);
  activeJob = { attachmentId, controller, promise };
  try {
    return await promise;
  } finally {
    activeJob = undefined;
  }
}

async function runFulltext(
  attachmentId: number,
  progress: (status: Status) => void,
  signal: AbortSignal,
): Promise<Zotero.Item> {
  const model = getActiveModelSnapshot();
  progress({ phase: "source", model: model.label });
  const source = await resolveSource(attachmentId);
  requireParent(source);
  const { identity } = source;
  const pathSegments = [
    "paper-translate-for-zotero-fulltext",
    identity.libraryID + "-" + identity.attachmentKey,
  ];
  const directory = joinPath(source.dataDir, ...pathSegments);
  const fingerprint = {
    source: identity.attachmentID,
    parent: identity.parentItemKey,
    markdown: source.fullMdSha256,
    manifest: source.manifestSha256,
    language: "zh-CN",
    promptVersion: FULLTEXT_PROMPT_VERSION,
    model: {
      provider: model.providerId,
      id: model.id,
      auth: model.authMode,
      protocol: model.protocol,
      address: model.apiBase,
      name: model.model,
      effort: model.effort,
      workspace: model.workspaceId,
      anthropicVersion: model.anthropicVersion,
      maxTokens: model.maxTokens,
    },
  };
  // Persist only a fingerprint, never the endpoint, credentials or provider configuration.
  const fingerprintHash = await sha256Hex(
    new TextEncoder().encode(JSON.stringify(fingerprint)),
  );
  const checkpointPath = joinPath(
    directory,
    "blocks-" + fingerprintHash + ".json",
  );
  const document = parseFulltext(source.markdown);
  if (!document.units.length)
    throw new Error("MinerU Markdown 中没有可翻译的正文");
  signal.throwIfAborted();
  await ensureGeneratedDirectory(source.dataDir, pathSegments);
  const checkpoint = await readCheckpoint(checkpointPath, directory);
  const translations = await translateFulltextUnits({
    units: document.units,
    checkpoint,
    model,
    signal,
    progress: (done, total) =>
      progress({ phase: "translating", model: model.label, done, total }),
    async save(results) {
      await writeAtomic(
        directory,
        checkpointPath,
        JSON.stringify(Object.fromEntries(results)),
      );
    },
  });
  progress({ phase: "output", model: model.label });
  const figureMetadata = await readFulltextFigureMetadata(
    source.mineruCacheDir,
  );
  const figures = resolveFulltextFigures(
    source.manifest,
    source.markdown,
    figureMetadata,
  );
  const assets = await loadFulltextAssets(
    source.mineruCacheDir,
    [...document.imagePaths, ...figures.map((figure) => figure.path)],
    signal,
  );
  const html = renderFulltext(document, translations, {
    title: identity.title,
    model: model.label,
    assets,
    figures,
  });
  signal.throwIfAborted();
  return withFulltextPaperDirectory(source, (paperDir) => {
    signal.throwIfAborted();
    return saveAttachment(
      requireParent(source),
      paperDir,
      identity.attachmentKey,
      html,
    );
  });
}

async function resolveSource(attachmentId: number): Promise<Source> {
  try {
    return await readValidatedMineruSource(attachmentId);
  } catch (error) {
    if (error instanceof MineruMarkdownUnavailableError)
      throw new Error(
        error.message +
          "。请先在 llm-for-zotero 中生成或恢复此 PDF 的 MinerU 缓存。",
      );
    throw error;
  }
}

function requireParent(source: Source): Zotero.Item {
  const { identity } = source;
  if (
    !Number.isSafeInteger(identity.libraryID) ||
    !/^[A-Z0-9]{8}$/u.test(identity.attachmentKey)
  )
    throw new Error("无效的 Zotero 全文翻译源标识");
  const pdf = Zotero.Items.get(identity.attachmentID);
  const parent = pdf && pdf.parentItemID && Zotero.Items.get(pdf.parentItemID);
  if (
    !pdf ||
    pdf.deleted ||
    !pdf.isPDFAttachment() ||
    pdf.key !== identity.attachmentKey ||
    !parent ||
    parent.deleted ||
    !parent.isRegularItem() ||
    !parent.isEditable() ||
    parent.key !== identity.parentItemKey ||
    parent.libraryID !== identity.libraryID
  )
    throw new Error("找不到同一条目下可写入双语附件的源 PDF");
  return parent;
}

async function readCheckpoint(
  path: string,
  directory: string,
): Promise<Record<string, string>> {
  if (!(await IOUtils.exists(path))) return Object.create(null);
  const safePath = await safeGeneratedPath(directory, path);
  const data: unknown = JSON.parse(await IOUtils.readUTF8(safePath));
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("全文翻译断点文件格式无效");
  return data as Record<string, string>;
}

async function saveAttachment(
  parent: Zotero.Item,
  directory: string,
  sourceKey: string,
  html: string,
): Promise<Zotero.Item> {
  const itemTitle = String(parent.getField("title") || "").trim();
  const words =
    typeof Intl.Segmenter === "function"
      ? Array.from(
          new Intl.Segmenter(undefined, { granularity: "word" }).segment(
            itemTitle,
          ),
        )
          .filter((word) => word.isWordLike)
          .map(({ index, segment }) => ({ index, length: segment.length }))
      : Array.from(
          itemTitle.matchAll(/\p{Script=Han}|[\p{L}\p{M}\p{N}]+/gu),
          (match) => ({ index: match.index, length: match[0].length }),
        );
  const lastWord = words[Math.min(words.length, 5) - 1];
  const title = lastWord
    ? itemTitle.slice(words[0].index, lastWord.index + lastWord.length) +
      "-Translate"
    : "Paper-Translate";
  const filename = "paper-translate-" + sourceKey + ".bilingual.html";
  const marker =
    "<!-- Paper Translate fulltext " + parent.key + "/" + sourceKey + " -->";
  const output = html.replace("<!doctype html>", "<!doctype html>" + marker);
  const file = joinPath(directory, filename);
  await writeAtomic(directory, file, output);
  const attachmentCandidates = Zotero.Items.get(parent.getAttachments()).filter(
    (item) =>
      item.attachmentLinkMode === Zotero.Attachments.LINK_MODE_IMPORTED_FILE &&
      item.attachmentContentType === "text/html" &&
      item.attachmentFilename === filename,
  );
  for (const item of attachmentCandidates) {
    const path = await item.getFilePathAsync();
    if (!path) continue;
    const storage = Zotero.Attachments.getStorageDirectory(item).path;
    const safePath = await safeGeneratedPath(storage, path);
    const prefix = new TextDecoder().decode(
      await IOUtils.read(safePath, { maxBytes: 160 }),
    );
    if (!prefix.startsWith("<!doctype html>" + marker)) continue;
    await writeAtomic(storage, safePath, output);
    if (item.getField("title") !== title) {
      item.setField("title", title);
      await item.saveTx();
    }
    return item;
  }
  return Zotero.Attachments.importFromFile({
    file,
    parentItemID: parent.id,
    title,
    contentType: "text/html",
    charset: "utf-8",
  });
}

async function ensureGeneratedDirectory(
  root: string,
  segments: string[],
): Promise<void> {
  let parent = root;
  for (const segment of segments) {
    const next = await safeGeneratedPath(parent, joinPath(parent, segment));
    await IOUtils.makeDirectory(next, { ignoreExisting: true });
    parent = next;
  }
}

async function writeAtomic(
  root: string,
  path: string,
  value: string,
): Promise<void> {
  const file = await safeGeneratedPath(root, path);
  const temporary = await safeGeneratedPath(root, path + ".tmp");
  await IOUtils.writeUTF8(file, value, { tmpPath: temporary });
}

async function safeGeneratedPath(root: string, path: string): Promise<string> {
  const access = createDefaultMineruImageFileAccess();
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const parent = await access.canonicalize(path.slice(0, separator));
  const candidate = joinPath(parent, path.slice(separator + 1));
  const safeRoot = await access.canonicalize(root);
  const safePath = (await IOUtils.exists(candidate))
    ? await access.canonicalize(candidate)
    : candidate;
  const slash = (value: string) =>
    value.replace(/\\/gu, "/").replace(/\/$/u, "");
  const base = slash(safeRoot);
  const target = slash(safePath);
  const within = /^[A-Za-z]:/u.test(base)
    ? target.toLowerCase().startsWith(base.toLowerCase() + "/")
    : target.startsWith(base + "/");
  if (!within) throw new Error("全文翻译输出路径超出允许的目录");
  return safePath;
}

function joinPath(root: string, ...parts: string[]): string {
  const separator = root.includes("\\") ? "\\" : "/";
  return [root.replace(/[\\/]+$/u, ""), ...parts].join(separator);
}
