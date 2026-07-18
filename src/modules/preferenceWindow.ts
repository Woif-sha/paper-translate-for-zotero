import { config, homepage } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, PrefKeys, setPref } from "../utils/prefs";
import { testLegacyCodexConnection } from "../codex/legacyClient";

const STRING_FIELDS: PrefKeys[] = [
  "sourceLanguage",
  "paper.codexApiUrl",
  "paper.codexModel",
];

export const PREFERENCES_PANE_ID = `${config.addonRef}-preferences`;
const CONNECTION_TEST_TIMEOUT_MS = 30_000;
let preferencesRegistered = false;
let connectionTestController: AbortController | undefined;

export async function registerPrefsWindow(): Promise<void> {
  if (preferencesRegistered) return;
  await Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    id: PREFERENCES_PANE_ID,
    src: rootURI + "chrome/content/preferences.xhtml",
    label: "paper-translate-for-zotero",
    image: `chrome://${config.addonRef}/content/icons/section-20.png`,
    helpURL: homepage,
  });
  preferencesRegistered = true;
}

export function unregisterPrefsWindow(): void {
  cancelConnectionTest();
  if (!preferencesRegistered) return;
  Zotero.PreferencePanes.unregister(PREFERENCES_PANE_ID);
  preferencesRegistered = false;
}

export function registerPrefsScripts(window: Window) {
  addon.data.prefs.window = window;
  const doc = window.document;
  for (const key of STRING_FIELDS) bindTextField(doc, key);
  bindSelect(doc, "paper.codexEffort");
  bindCodexConnectionTest(doc);
  window.addEventListener("unload", cancelConnectionTest, { once: true });
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
      cancelConnectionTest();
      const controller = new AbortController();
      connectionTestController = controller;
      const timeout = setTimeout(
        () => controller.abort(),
        CONNECTION_TEST_TIMEOUT_MS,
      );
      button.disabled = true;
      status.hidden = false;
      status.style.color = "var(--fill-secondary, #777)";
      status.textContent = getString("pref-codex-testing");
      try {
        const reply = await testLegacyCodexConnection({
          apiUrl: fieldValue(doc, "paper-codexApiUrl"),
          model: fieldValue(doc, "paper-codexModel"),
          effort: fieldValue(doc, "paper-codexEffort"),
          signal: controller.signal,
        });
        if (connectionTestController !== controller) return;
        status.style.color = "green";
        status.textContent = `${getString("pref-codex-success")}: ${reply}`;
      } catch (error) {
        if (connectionTestController !== controller) return;
        status.style.color = "red";
        status.textContent = `${getString("pref-codex-failed")}: ${String(error)}`;
      } finally {
        clearTimeout(timeout);
        if (connectionTestController === controller) {
          connectionTestController = undefined;
          button.disabled = false;
        }
      }
    })();
  });
}

function cancelConnectionTest(): void {
  connectionTestController?.abort();
  connectionTestController = undefined;
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
