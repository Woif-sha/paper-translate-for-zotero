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

test("offers only the llm-for-zotero legacy Codex configuration", async () => {
  const markup = await readFile(
    new URL("../addon/chrome/content/preferences.xhtml", import.meta.url),
    "utf8",
  );
  assert.match(markup, /Codex Auth \(Legacy\)/);
  assert.match(markup, /paper-codexApiUrl/);
  assert.doesNotMatch(markup, /Codex App Server/);
  assert.doesNotMatch(markup, /chat-completions|paper-apiKey|paper-codexPath/);
});
