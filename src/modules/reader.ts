import { config } from "../../package.json";

let readerInitializerRegistered = false;

const onRenderTextSelectionPopup: _ZoteroTypes.Reader.EventHandler<
  "renderTextSelectionPopup"
> = (event) => {
  addon.data.translate.selectedText = normalizeReaderSelection(
    event.params.annotation.text,
  );
  addon.hooks.onReaderPopupShow(event);
};

export function registerReaderInitializer() {
  if (readerInitializerRegistered) return;
  Zotero.Reader.registerEventListener(
    "renderTextSelectionPopup",
    onRenderTextSelectionPopup,
    config.addonID,
  );
  readerInitializerRegistered = true;
}

export function unregisterReaderInitializer(): void {
  if (!readerInitializerRegistered) return;
  Zotero.Reader.unregisterEventListener(
    "renderTextSelectionPopup",
    onRenderTextSelectionPopup,
  );
  readerInitializerRegistered = false;
}

const PARAGRAPH_MARKER = "\uE000";
const BULLET_PATTERN = "[•●▪◦‣]";
const CROSS_PAGE_NOISE_PATTERNS = [
  /Authorized licensed use limited to:[^.\r\n]{1,240}\.\s*Downloaded on [^.\r\n]{1,360}?from IEEE Xplore\.\s*Restrictions apply\.?/giu,
  /Downloaded on [^.\r\n]{1,360}?from IEEE Xplore\.\s*Restrictions apply\.?/giu,
  /Authorized licensed use limited to:[^.\r\n]{1,240}\./giu,
  /Downloaded on [^.\r\n]{1,360}?from IEEE Xplore\.?/giu,
  /\b\d+[A-Z]-\d+\s+\d+\s+\d{4}\s+\d+(?:st|nd|rd|th)\s+[^|\r\n]{1,200}\([^)\r\n]{1,60}\)\s*\|/giu,
  /\|\s*DOI:\s*10\.\d{4,9}\/[-._;()/:A-Z0-9]+/giu,
  /97[89]-[\d-]+\/\d+\/\$[\d.]+\s*©\s*\d{4}\s*IEEE/giu,
];

export function normalizeReaderSelection(value: string): string {
  let text = value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ");
  for (const pattern of CROSS_PAGE_NOISE_PATTERNS) {
    text = text.replace(pattern, " ");
  }
  text = text
    .split("\n")
    .filter((line) => !isStandalonePageArtifact(line))
    .join("\n")
    .replace(
      new RegExp(`(^|\\n)[\\t ]*(${BULLET_PATTERN})[\\t ]*`, "gmu"),
      (_match, _lineStart, bullet, offset) =>
        `${offset > 0 ? PARAGRAPH_MARKER : ""}${bullet} `,
    )
    .replace(/\n\s*\n+/g, PARAGRAPH_MARKER)
    .replace(/(\S)-[\t ]*\n[\t ]*(?=\p{Ll}{2})/gu, "$1-")
    .replace(/[\t ]*\n[\t ]*/g, " ")
    .replace(/[\t ]+/g, " ")
    .replace(new RegExp(`\\s*${PARAGRAPH_MARKER}\\s*`, "gu"), "\n")
    .replace(/ *\n */g, "\n")
    .trim();
  return text;
}

function isStandalonePageArtifact(line: string): boolean {
  const value = line.trim();
  if (!value) return false;
  return (
    /^\d+[A-Z]-\d+(?:\s+\d+)?$/i.test(value) ||
    /^©\s*\d{4}\s+IEEE$/i.test(value)
  );
}
