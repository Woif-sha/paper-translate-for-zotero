import { config } from "../../package.json";

export function registerReaderInitializer() {
  Zotero.Reader.registerEventListener(
    "renderTextSelectionPopup",
    (event) => {
      addon.data.translate.selectedText = normalizeReaderSelection(
        event.params.annotation.text,
      );
      addon.hooks.onReaderPopupShow(event);
    },
    config.addonID,
  );
}

const PARAGRAPH_MARKER = "\uE000";
const BULLET_PATTERN = "[•●▪◦‣]";
const CROSS_PAGE_NOISE_PATTERNS = [
  /97[89]-[\d-]+\/\d+\/\$[\d.]+\s*©\s*\d{4}\s*IEEE[\s\S]*?Restrictions apply\.?/giu,
  /Authorized licensed use limited to:[\s\S]*?Restrictions apply\.?/giu,
  /Downloaded on [\s\S]*?from IEEE Xplore\.[\s\S]*?Restrictions apply\.?/giu,
  /Downloaded on [\s\S]*?from IEEE Xplore\.?/giu,
  /Restrictions apply\.?/giu,
  /97[89]-[\d-]+\/\d+\/\$[\d.]+\s*©\s*\d{4}\s*IEEE/giu,
];

export function normalizeReaderSelection(value: string): string {
  let text = value
    .normalize("NFKC")
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
      new RegExp(`\\s*(${BULLET_PATTERN})\\s*`, "gu"),
      (_match, bullet, offset) =>
        `${offset > 0 ? PARAGRAPH_MARKER : ""}${bullet} `,
    )
    .replace(/\n\s*\n+/g, PARAGRAPH_MARKER)
    .replace(/-\s*\n\s*(?=\p{Ll})/gu, "")
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
    /^\d{1,4}$/.test(value) ||
    /^\d+[A-Z]-\d+(?:\s+\d+)?$/i.test(value) ||
    /^©\s*\d{4}\s+IEEE$/i.test(value)
  );
}
