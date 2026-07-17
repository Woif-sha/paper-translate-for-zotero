import { config, homepage } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, PrefKeys, setPref } from "../utils/prefs";
import { getServiceSecret, setServiceSecret } from "../utils/secret";
import { testCodexConnection } from "../codex/appServer";

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
    label: "paper-translate-for-zotero",
    image: `chrome://${config.addonRef}/content/icons/section-20.png`,
    helpURL: homepage,
  });
}

export function registerPrefsScripts(window: Window) {
  addon.data.prefs.window = window;
  const doc = window.document;
  for (const key of STRING_FIELDS) bindTextField(doc, key);
  bindSelect(doc, "paper.backend");
  bindSelect(doc, "paper.codexEffort");
  bindCodexConnectionTest(doc);
  const apiKey = doc.querySelector(
    `#${makeId("paper-apiKey")}`,
  ) as HTMLInputElement;
  apiKey.value = getServiceSecret("paper-context");
  apiKey.addEventListener("change", () =>
    setServiceSecret("paper-context", apiKey.value.trim()),
  );
}

function bindCodexConnectionTest(doc: Document): void {
  const button = doc.querySelector(
    `#${makeId("paper-codexTest")}`,
  ) as HTMLButtonElement;
  const status = doc.querySelector(
    `#${makeId("paper-codexStatus")}`,
  ) as HTMLSpanElement;
  button.addEventListener("click", () => {
    void (async () => {
      button.disabled = true;
      status.hidden = false;
      status.style.color = "var(--fill-secondary, #777)";
      status.textContent = getString("pref-codex-testing");
      try {
        const reply = await testCodexConnection({
          codexPath: fieldValue(doc, "paper-codexPath"),
          model: fieldValue(doc, "paper-codexModel"),
          effort: fieldValue(doc, "paper-codexEffort"),
        });
        status.style.color = "green";
        status.textContent = `${getString("pref-codex-success")}: ${reply}`;
      } catch (error) {
        status.style.color = "red";
        status.textContent = `${getString("pref-codex-failed")}: ${String(error)}`;
      } finally {
        button.disabled = false;
      }
    })();
  });
}

function fieldValue(doc: Document, id: string): string {
  return String(
    (
      doc.querySelector(`#${makeId(id)}`) as
        | HTMLInputElement
        | HTMLSelectElement
    ).value || "",
  ).trim();
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
