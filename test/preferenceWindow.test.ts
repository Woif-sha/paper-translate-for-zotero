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

test("renders the shared provider editor while keeping the target language fixed", async () => {
  const markup = await readFile(
    new URL("../addon/chrome/content/preferences.xhtml", import.meta.url),
    "utf8",
  );
  assert.match(markup, /model-providers/);
  assert.match(markup, /add-provider/);
  assert.doesNotMatch(markup, /Codex App Server/);
  assert.doesNotMatch(markup, /paper-codexPath/);
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
  assert.match(defaults, /paper\.modelProviders", ""/);
  assert.match(defaults, /paper\.activeModelId", ""/);
  assert.match(defaults, /targetLanguage", "zh-CN"/);
  const runtimeDefaults = await readFile(
    new URL("../src/modules/defaultPrefs.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    runtimeDefaults,
    /setPref\("paper\.codexApiUrl", DEFAULT_CODEX_API_URL\)/,
  );
  const script = await readFile(
    new URL("../src/modules/preferenceWindow.ts", import.meta.url),
    "utf8",
  );
  assert.match(script, /subscribeModelConfiguration\(render\)/u);
});

test("keeps dynamic provider controls localized and compact", async () => {
  const script = await readFile(
    new URL("../src/modules/preferenceWindow.ts", import.meta.url),
    "utf8",
  );
  const addonLocales = await Promise.all(
    ["zh-CN", "en-US"].map((locale) =>
      readFile(
        new URL(`../addon/locale/${locale}/addon.ftl`, import.meta.url),
        "utf8",
      ),
    ),
  );
  const dynamicKeys = [...script.matchAll(/getString\("(pref-[^"]+)"\)/gu)].map(
    (match) => match[1],
  );

  assert.ok(dynamicKeys.length > 0);
  for (const addonLocale of addonLocales) {
    for (const key of new Set(dynamicKeys)) {
      assert.match(addonLocale, new RegExp(`^${key}\\s*=`, "mu"));
    }
  }
  assert.match(script, /actionButton\(doc, "×"/u);
  assert.match(script, /nextProviderName/u);
  assert.match(addonLocales[0], /^pref-provider-save\s*=\s*保存$/mu);
  assert.match(script, /getString\("pref-codex-test"\)/u);
  assert.match(script, /row\.append\(select, test, remove\)/u);
});
