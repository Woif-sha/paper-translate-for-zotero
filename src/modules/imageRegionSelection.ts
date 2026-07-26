import { config } from "../../package.json";

const PAGE_SELECTOR = ".page[data-page-number], .page[data-page-index]";
const MINIMUM_SELECTION_SIZE_PX = 4;

export type SupportedPageRotation = 0 | 90 | 180 | 270;

export type ReaderImageRegion = {
  pageIndex: number;
  displayRect: [number, number, number, number];
  rotation: SupportedPageRotation;
  runtimeDocument: Document;
};

export async function selectReaderImageRegion(params: {
  reader: unknown;
  signal: AbortSignal;
  instruction: string;
  cancelLabel: string;
}): Promise<ReaderImageRegion | null> {
  const view = resolveActiveReaderView(params.reader);
  const doc = resolveReaderViewDocument(view);
  const pages = collectPageContainers(doc);
  if (!pages.length) {
    throw new Error("The active Reader view has no PDF page containers");
  }
  const rotationForPage = (pageIndex: number) =>
    resolvePageRotation(view, pageIndex);
  return createRegionSelectionOverlay({
    doc,
    pages,
    signal: params.signal,
    instruction: params.instruction,
    cancelLabel: params.cancelLabel,
    rotationForPage,
  });
}

export function parseReaderPageIndex(element: Element): number {
  const pageNumber = Number.parseInt(
    element.getAttribute("data-page-number") || "",
    10,
  );
  if (Number.isInteger(pageNumber) && pageNumber >= 1) return pageNumber - 1;
  const pageIndex = Number.parseInt(
    element.getAttribute("data-page-index") || "",
    10,
  );
  if (Number.isInteger(pageIndex) && pageIndex >= 0) return pageIndex;
  throw new Error("Rendered Reader page has no valid page index");
}

export function normalizeDisplaySelection(
  pageRect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  selection: [number, number, number, number],
): [number, number, number, number] {
  if (pageRect.width <= 0 || pageRect.height <= 0) {
    throw new Error("Rendered Reader page has invalid geometry");
  }
  const [left, top, right, bottom] = selection;
  const normalized = [
    ((left - pageRect.left) / pageRect.width) * 1000,
    ((top - pageRect.top) / pageRect.height) * 1000,
    ((right - pageRect.left) / pageRect.width) * 1000,
    ((bottom - pageRect.top) / pageRect.height) * 1000,
  ] as [number, number, number, number];
  if (
    normalized.some((value) => !Number.isFinite(value)) ||
    normalized[0] < 0 ||
    normalized[1] < 0 ||
    normalized[2] > 1000 ||
    normalized[3] > 1000 ||
    normalized[2] <= normalized[0] ||
    normalized[3] <= normalized[1]
  ) {
    throw new Error("Image selection must stay inside one rendered page");
  }
  return normalized.map(roundCoordinate) as [number, number, number, number];
}

function resolveActiveReaderView(reader: unknown): any {
  const internal = (reader as any)?._internalReader;
  if (!internal) throw new Error("The active Zotero Reader is unavailable");
  const view =
    internal._lastView ||
    (internal._lastViewPrimary === false
      ? internal._secondaryView
      : internal._primaryView);
  if (!view) throw new Error("The active PDF Reader view is unavailable");
  return view;
}

function resolveReaderViewDocument(view: any): Document {
  const candidates = [
    () => view?._iframeWindow?.document as Document | undefined,
    () => view?._iframe?.contentDocument as Document | undefined,
  ];
  for (const resolve of candidates) {
    try {
      const doc = resolve();
      if (doc?.documentElement && doc.defaultView) return doc;
    } catch {
      // A Reader iframe can be replaced while its tab is reloading.
    }
  }
  throw new Error("Cannot access the active PDF Reader document");
}

function collectPageContainers(doc: Document): HTMLElement[] {
  const seen = new Set<number>();
  const pages: HTMLElement[] = [];
  for (const page of doc.querySelectorAll(PAGE_SELECTOR)) {
    const element = page as HTMLElement;
    const pageIndex = parseReaderPageIndex(element);
    if (seen.has(pageIndex)) continue;
    seen.add(pageIndex);
    pages.push(element);
  }
  return pages;
}

function resolvePageRotation(
  view: any,
  pageIndex: number,
): SupportedPageRotation {
  const app =
    view?._iframeWindow?.PDFViewerApplication ||
    view?._iframe?.contentWindow?.PDFViewerApplication ||
    view?._iframeWindow?.wrappedJSObject?.PDFViewerApplication ||
    view?._iframe?.contentWindow?.wrappedJSObject?.PDFViewerApplication;
  const rotation = Number(
    app?.pdfViewer?.getPageView?.(pageIndex)?.viewport?.rotation,
  );
  const normalized = ((rotation % 360) + 360) % 360;
  if ([0, 90, 180, 270].includes(normalized)) {
    return normalized as SupportedPageRotation;
  }
  throw new Error(
    `Cannot resolve the rotation of rendered page ${pageIndex + 1}`,
  );
}

function createRegionSelectionOverlay(params: {
  doc: Document;
  pages: HTMLElement[];
  signal: AbortSignal;
  instruction: string;
  cancelLabel: string;
  rotationForPage(pageIndex: number): SupportedPageRotation;
}): Promise<ReaderImageRegion | null> {
  if (params.signal.aborted) throw createAbortError();
  const container = params.doc.body || params.doc.documentElement;
  const overlay = htmlElement(params.doc, "div");
  overlay.id = `${config.addonRef}-image-selection-overlay`;
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483646",
    cursor: "crosshair",
    background: "rgba(17, 24, 39, 0.12)",
    userSelect: "none",
  });
  const instruction = htmlElement(params.doc, "div");
  instruction.textContent = params.instruction;
  Object.assign(instruction.style, {
    position: "fixed",
    top: "18px",
    left: "50%",
    transform: "translateX(-50%)",
    maxWidth: "min(560px, calc(100vw - 32px))",
    padding: "8px 14px",
    border: "1px solid rgba(255, 255, 255, 0.24)",
    borderRadius: "9px",
    color: "#fff",
    background: "rgba(23, 59, 50, 0.92)",
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.2)",
    font: "13px/1.4 sans-serif",
    pointerEvents: "none",
  });
  const cancel = htmlElement(params.doc, "button");
  cancel.type = "button";
  cancel.textContent = params.cancelLabel;
  Object.assign(cancel.style, {
    position: "fixed",
    right: "18px",
    top: "18px",
    padding: "7px 12px",
    border: "1px solid rgba(255, 255, 255, 0.38)",
    borderRadius: "9px",
    color: "#fff",
    background: "rgba(23, 59, 50, 0.92)",
    font: "13px/1.4 sans-serif",
    cursor: "pointer",
  });
  const selection = htmlElement(params.doc, "div");
  Object.assign(selection.style, {
    position: "fixed",
    display: "none",
    border: "2px solid #20a77a",
    borderRadius: "3px",
    background: "rgba(32, 167, 122, 0.16)",
    boxShadow: "0 0 0 1px rgba(255, 255, 255, 0.85)",
    pointerEvents: "none",
  });
  overlay.append(instruction, cancel, selection);
  container.append(overlay);

  return new Promise((resolve, reject) => {
    let settled = false;
    let selecting = false;
    let startX = 0;
    let startY = 0;

    const cleanup = () => {
      params.doc.removeEventListener("keydown", onKeyDown, true);
      params.signal.removeEventListener("abort", onAbort);
      overlay.remove();
    };
    const finish = (value: ReaderImageRegion | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => fail(createAbortError());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      finish(null);
    };
    const updateSelection = (clientX: number, clientY: number) => {
      const left = Math.min(startX, clientX);
      const top = Math.min(startY, clientY);
      const width = Math.abs(clientX - startX);
      const height = Math.abs(clientY - startY);
      Object.assign(selection.style, {
        display: "block",
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
      });
    };

    params.doc.addEventListener("keydown", onKeyDown, true);
    params.signal.addEventListener("abort", onAbort, { once: true });
    cancel.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      finish(null);
    });
    overlay.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target === cancel) return;
      event.preventDefault();
      event.stopPropagation();
      selecting = true;
      startX = event.clientX;
      startY = event.clientY;
      overlay.setPointerCapture(event.pointerId);
      updateSelection(event.clientX, event.clientY);
    });
    overlay.addEventListener("pointermove", (event) => {
      if (!selecting) return;
      event.preventDefault();
      updateSelection(event.clientX, event.clientY);
    });
    overlay.addEventListener("pointerup", (event) => {
      if (!selecting) return;
      event.preventDefault();
      event.stopPropagation();
      selecting = false;
      const rect = canonicalRect(startX, startY, event.clientX, event.clientY);
      if (
        rect[2] - rect[0] < MINIMUM_SELECTION_SIZE_PX ||
        rect[3] - rect[1] < MINIMUM_SELECTION_SIZE_PX
      ) {
        fail(new Error("Image selection is too small"));
        return;
      }
      try {
        const page = findContainingPage(params.pages, rect);
        const pageIndex = parseReaderPageIndex(page);
        finish({
          pageIndex,
          displayRect: normalizeDisplaySelection(
            getRenderedPageSurfaceRect(page),
            rect,
          ),
          rotation: params.rotationForPage(pageIndex),
          runtimeDocument: params.doc,
        });
      } catch (error) {
        fail(error);
      }
    });
  });
}

export function findContainingPage(
  pages: readonly HTMLElement[],
  selection: [number, number, number, number],
): HTMLElement {
  const tolerance = 1;
  const matches = pages.filter((page) => {
    const rect = getPageContainerRect(page);
    return (
      selection[0] >= rect.left - tolerance &&
      selection[1] >= rect.top - tolerance &&
      selection[2] <= rect.right + tolerance &&
      selection[3] <= rect.bottom + tolerance
    );
  });
  if (matches.length !== 1) {
    throw new Error("Image selection must stay inside exactly one PDF page");
  }
  return matches[0];
}

function getPageContainerRect(page: HTMLElement): DOMRect {
  const rect = page.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    throw new Error("Reader page container has invalid geometry");
  }
  return rect;
}

export function getRenderedPageSurfaceRect(page: HTMLElement): DOMRect {
  const surface = page.querySelector(".canvasWrapper") as HTMLElement | null;
  if (!surface) {
    throw new Error("The selected PDF page has not finished rendering");
  }
  const rect = surface.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    throw new Error("The selected PDF page has invalid surface geometry");
  }
  return rect;
}

function canonicalRect(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): [number, number, number, number] {
  return [
    Math.min(startX, endX),
    Math.min(startY, endY),
    Math.max(startX, endX),
    Math.max(startY, endY),
  ];
}

function roundCoordinate(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function createAbortError(): Error {
  const error = new Error("Image text selection was cancelled");
  error.name = "AbortError";
  return error;
}

function htmlElement<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
): HTMLElementTagNameMap[K] {
  return doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    tag,
  ) as HTMLElementTagNameMap[K];
}
