import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { registerPrefsWindow } from "../src/modules/preferenceWindow";

test("registers the exact plugin name and a correctly sized settings icon", async () => {
  let options: any;
  (globalThis as any).rootURI = "resource://paper-translate/";
  (globalThis as any).Zotero = {
    PreferencePanes: {
      async register(value: any) {
        options = value;
        return value.id;
      },
    },
  };

  await registerPrefsWindow();

  assert.equal(options.label, "paper-translate-for-zotero");
  assert.equal(options.id, "papertranslateforzotero-preferences");
  assert.match(options.image, /section-20\.png$/);
});

test("locks the Codex authentication mode and defaults to the legacy endpoint", async () => {
  const markup = await readFile(
    new URL("../addon/chrome/content/preferences.xhtml", import.meta.url),
    "utf8",
  );
  assert.match(markup, /value="Codex Auth"/);
  assert.match(
    markup,
    /paper-authMode[\s\S]*readonly="readonly"[\s\S]*disabled="disabled"/,
  );
  assert.doesNotMatch(markup, /\(Legacy\)|pref-context-note/);
  assert.match(markup, /paper-codexApiUrl/);
  assert.doesNotMatch(markup, /Codex App Server/);
  assert.doesNotMatch(markup, /chat-completions|paper-apiKey|paper-codexPath/);
  assert.match(
    markup,
    /targetLanguage[\s\S]*value="zh-CN"[\s\S]*readonly="readonly"[\s\S]*disabled="disabled"/,
  );
  const defaults = await readFile(
    new URL("../addon/prefs.js", import.meta.url),
    "utf8",
  );
  assert.match(defaults, /paper\.codexModel", "gpt-5\.4"/);
  assert.match(defaults, /paper\.codexEffort", "medium"/);
  assert.match(defaults, /targetLanguage", "zh-CN"/);
  const runtimeDefaults = await readFile(
    new URL("../src/modules/defaultPrefs.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    runtimeDefaults,
    /setPref\("paper\.codexApiUrl", DEFAULT_CODEX_API_URL\)/,
  );
});
