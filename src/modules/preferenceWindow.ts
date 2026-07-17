import { config, homepage } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, PrefKeys, setPref } from "../utils/prefs";
import { getServiceSecret, setServiceSecret } from "../utils/secret";

const STRING_FIELDS: PrefKeys[] = [
  "sourceLanguage",
  "targetLanguage",
  "paper.codexPath",
  "paper.codexModel",
  "paper.apiEndpoint",
  "paper.apiModel",
  "paper.temperature",
];

export const PREFERENCES_PANE_ID = `${config.addonRef}-preferences`;

export async function registerPrefsWindow(): Promise<void> {
  await Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    id: PREFERENCES_PANE_ID,
    src: rootURI + "chrome/content/preferences.xhtml",
    label: getString("pref-title"),
    image: `chrome://${config.addonRef}/content/icons/favicon.png`,
    helpURL: homepage,
  });
}

export function registerPrefsScripts(window: Window) {
  addon.data.prefs.window = window;
  const doc = window.document;
  for (const key of STRING_FIELDS) bindTextField(doc, key);
  bindSelect(doc, "paper.backend");
  bindSelect(doc, "paper.codexEffort");
  const apiKey = doc.querySelector(
    `#${makeId("paper-apiKey")}`,
  ) as HTMLInputElement;
  apiKey.value = getServiceSecret("paper-context");
  apiKey.addEventListener("change", () =>
    setServiceSecret("paper-context", apiKey.value.trim()),
  );
}

function bindTextField(doc: Document, key: PrefKeys): void {
  const field = doc.querySelector(
    `#${makeId(key.replaceAll(".", "-"))}`,
  ) as HTMLInputElement;
  field.value = String(getPref(key) ?? "");
  field.addEventListener("change", () => setPref(key, field.value.trim()));
}

function bindSelect(doc: Document, key: PrefKeys): void {
  const field = doc.querySelector(
    `#${makeId(key.replaceAll(".", "-"))}`,
  ) as HTMLSelectElement;
  field.value = String(getPref(key) ?? "");
  field.addEventListener("change", () => setPref(key, field.value));
}

function makeId(value: string): string {
  return `${config.addonRef}-${value}`;
}
