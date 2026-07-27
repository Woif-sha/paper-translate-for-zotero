import {
  assertValidatedPaperContextCurrent,
  preparePaperContext,
  type ValidatedPaperContext,
} from "../context/runtime";
import { selectReaderImageRegion } from "../modules/imageRegionSelection";
import {
  createOcrCacheKey,
  cropMineruImageSelection,
  loadMineruImageIndex,
  resolveMineruImageSelection,
  type OcrCacheKeyInput,
} from "./mineruImages";
import {
  OCR_PROMPT_VERSION,
  runModelImageOcr,
  type ModelOcrRequest,
} from "./modelOcr";
import { persistCachedOcrText, readCachedOcrText } from "./cache";
import { getActiveModelSnapshot, modelCacheIdentity } from "../models/runtime";

const OCR_REQUEST_TIMEOUT_MS = 60_000;

export type ImageTextRecognitionPhase =
  | "idle"
  | "selecting"
  | "recognizing"
  | "error";

export type ImageTextRecognitionState = {
  phase: ImageTextRecognitionPhase;
  detail?: string;
};

type ActiveImageTextRecognition = {
  controller: AbortController;
  notify(state: ImageTextRecognitionState): void;
};

const activeRecognitions = new Map<number, ActiveImageTextRecognition>();

export async function startImageTextRecognition(params: {
  attachmentItemID: number;
  reader: unknown;
  instruction: string;
  cancelLabel: string;
  onStateChange(state: ImageTextRecognitionState): void;
}): Promise<string | null> {
  if (
    !Number.isInteger(params.attachmentItemID) ||
    params.attachmentItemID <= 0
  ) {
    throw new Error("Image OCR requires a Reader attachment item ID");
  }
  cancelImageTextRecognition(params.attachmentItemID);
  const controller = new AbortController();
  const active = {
    controller,
    notify: params.onStateChange,
  };
  activeRecognitions.set(params.attachmentItemID, active);
  const runtimeModel = getActiveModelSnapshot();
  publishState(params.attachmentItemID, active, { phase: "selecting" });
  let failureDetail: string | undefined;
  try {
    const context = await preparePaperContext(params.attachmentItemID, "");
    assertReaderMatchesContext(params.reader, context);
    const imageIndex = await loadMineruImageIndex(context.mineruCacheDir);
    const region = await selectReaderImageRegion({
      reader: params.reader,
      signal: controller.signal,
      instruction: params.instruction,
      cancelLabel: params.cancelLabel,
    });
    if (!region) return null;
    assertActive(params.attachmentItemID, active);
    publishState(params.attachmentItemID, active, { phase: "recognizing" });
    const imageSelection = resolveMineruImageSelection(
      imageIndex,
      region.pageIndex,
      region.displayRect,
      region.rotation,
    );
    const crop = await cropMineruImageSelection(
      imageIndex,
      imageSelection,
      region.runtimeDocument,
      { signal: controller.signal },
    );
    const keyInput: OcrCacheKeyInput = {
      attachmentKey: context.identity.attachmentKey,
      imageSha256: crop.imageSha256,
      contentListSha256: crop.contentListSha256,
      crop: crop.crop,
      model: modelCacheIdentity(runtimeModel),
      effort: runtimeModel.effort,
      promptVersion: OCR_PROMPT_VERSION,
    };
    const key = await createOcrCacheKey(keyInput);
    const cached = await readCachedOcrText({ context, key });
    await assertRecognitionCurrent(params.attachmentItemID, active, context);
    if (cached) return cached;
    const text = await runOcrWithTimeout(
      {
        runtimeModel,
        imageDataUrl: crop.dataUrl,
      },
      controller.signal,
    );
    assertActive(params.attachmentItemID, active);
    await persistCachedOcrText({
      context,
      key,
      keyInput,
      text,
      assertCurrent: () =>
        assertRecognitionCurrent(params.attachmentItemID, active, context),
    });
    assertActive(params.attachmentItemID, active);
    return text;
  } catch (error) {
    if (!isCancellation(error, controller.signal)) {
      failureDetail = conciseError(error);
    }
    throw error;
  } finally {
    if (activeRecognitions.get(params.attachmentItemID) === active) {
      activeRecognitions.delete(params.attachmentItemID);
      if (!controller.signal.aborted) {
        active.notify(
          failureDetail
            ? { phase: "error", detail: failureDetail }
            : { phase: "idle" },
        );
      }
    }
  }
}

export function cancelImageTextRecognition(attachmentItemID?: number): void {
  if (attachmentItemID !== undefined) {
    const active = activeRecognitions.get(attachmentItemID);
    if (!active) return;
    activeRecognitions.delete(attachmentItemID);
    active.controller.abort(createCancellationError());
    active.notify({ phase: "idle" });
    return;
  }
  for (const [itemID, active] of activeRecognitions) {
    activeRecognitions.delete(itemID);
    active.controller.abort(createCancellationError());
    active.notify({ phase: "idle" });
  }
}

export function imageTextRecognitionIsActive(
  attachmentItemID: number,
): boolean {
  return activeRecognitions.has(attachmentItemID);
}

async function assertPaperContextCurrent(
  expected: ValidatedPaperContext,
): Promise<void> {
  await assertValidatedPaperContextCurrent(expected);
}

async function assertRecognitionCurrent(
  attachmentItemID: number,
  active: ActiveImageTextRecognition,
  context: ValidatedPaperContext,
): Promise<void> {
  assertActive(attachmentItemID, active);
  await assertPaperContextCurrent(context);
  assertActive(attachmentItemID, active);
}

function assertReaderMatchesContext(
  reader: unknown,
  context: ValidatedPaperContext,
): void {
  const readerItemID = Number((reader as { itemID?: unknown })?.itemID);
  if (readerItemID !== context.identity.attachmentID) {
    throw new Error("The active Reader does not match the OCR paper context");
  }
}

function publishState(
  attachmentItemID: number,
  active: ActiveImageTextRecognition,
  state: ImageTextRecognitionState,
): void {
  if (activeRecognitions.get(attachmentItemID) === active) active.notify(state);
}

function assertActive(
  attachmentItemID: number,
  active: ActiveImageTextRecognition,
): void {
  if (
    activeRecognitions.get(attachmentItemID) !== active ||
    active.controller.signal.aborted
  ) {
    throw createCancellationError();
  }
}

async function runOcrWithTimeout(
  request: Omit<ModelOcrRequest, "signal">,
  parentSignal: AbortSignal,
): Promise<string> {
  if (parentSignal.aborted) throw createCancellationError();
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () =>
    controller.abort(
      parentSignal.reason instanceof Error
        ? parentSignal.reason
        : createCancellationError(),
    );
  parentSignal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Image OCR exceeded 60 seconds"));
  }, OCR_REQUEST_TIMEOUT_MS);
  try {
    return await runModelImageOcr({
      ...request,
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) throw new Error("Image OCR exceeded 60 seconds");
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", onAbort);
  }
}

function conciseError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/\S+/gu, "[URL omitted]")
    .slice(0, 180);
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (error instanceof Error &&
      (error.name === "AbortError" ||
        error.message === "Image text recognition was cancelled"))
  );
}

function createCancellationError(): Error {
  const error = new Error("Image text recognition was cancelled");
  error.name = "AbortError";
  return error;
}
