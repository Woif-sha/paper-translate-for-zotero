import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { registerPrefsScripts } from "../src/modules/preferenceWindow";
import { createModelSelectionActions } from "../src/models/selection";
import {
  getModelProviderConfiguration,
  setActiveModelId,
  setModelProviderConfiguration,
} from "../src/models/providers";

test("draft fields survive auth changes, tab changes, pane reconstruction and reopening without applying them", async () => {
  const template = (
    await readFile(
      new URL("../addon/chrome/content/preferences.xhtml", import.meta.url),
      "utf8",
    )
  )
    .replaceAll("__addonRef__", "papertranslateforzotero")
    .replaceAll("html:", "");
  const prefs = new Map<string, unknown>();
  (globalThis as any).Zotero = {
    Prefs: {
      get: (key: string) => prefs.get(key),
      set: (key: string, value: unknown) => prefs.set(key, value),
    },
  };
  (globalThis as any).addon = {
    data: {
      prefs: {},
      locale: {
        current: {
          formatMessagesSync: (items: any[]) =>
            items.map((entry) => ({
              value: entry.id.replace("papertranslateforzotero-", ""),
            })),
        },
      },
    },
  };
  (globalThis as any).ztoolkit = {
    getGlobal: () => async () =>
      assert.fail("remembering drafts must not send any requests"),
  };
  setModelProviderConfiguration(
    [
      {
        id: "p",
        name: "Saved name",
        authMode: "openai_compatible",
        presetId: "openai-responses",
        protocol: "responses",
        apiBase: "https://api.openai.com/v1/responses",
        apiKey: "fake-saved-key",
        timeoutSeconds: 120,
        models: [{ id: "m", model: "saved-model", effort: "" }],
      },
    ],
    "m",
  );
  const actions = createModelSelectionActions({
    getConfiguration: getModelProviderConfiguration,
    setActiveModelId,
    setConfiguration: setModelProviderConfiguration,
    cancelModelTasks() {},
  });
  let dom = new JSDOM(template);
  const register = () =>
    registerPrefsScripts(dom.window as unknown as Window, actions);
  const field = (key: string) =>
    dom.window.document.querySelector(`[aria-label="${key}"]`) as
      | HTMLInputElement
      | HTMLSelectElement;
  const change = (key: string, value: string) => {
    const node = field(key);
    node.value = value;
    node.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  };
  const input = (key: string, value: string) => {
    const node = field(key);
    node.value = value;
    node.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  const click = (selector: string) =>
    (dom.window.document.querySelector(selector) as HTMLElement).click();
  const tab = (name: string) => click(`#papertranslateforzotero-${name}-tab`);
  const assertDraft = () => {
    assert.equal(field("pref-provider-name").value, "Draft name");
    assert.equal(
      field("pref-provider-api-base").value,
      "https://proxy.test/prefix/v1/responses",
    );
    assert.equal(field("pref-provider-api-key").value, "fake-draft-key");
    assert.equal(field("pref-provider-timeout").value, "90");
    assert.equal(field("pref-provider-model-id").value, "draft-model");
    assert.equal(field("pref-provider-protocol").value, "responses");
  };
  try {
    register();
    click(".pt-provider-toggle");
    change("pref-provider-preset", "custom");
    input("pref-provider-name", "Draft name");
    input("pref-provider-api-base", "https://proxy.test/prefix/v1/responses");
    input("pref-provider-api-key", "fake-draft-key");
    input("pref-provider-timeout", "90");
    input("pref-provider-model-id", "draft-model");
    change("pref-auth-mode", "codex_auth");
    click(".pt-model-options");
    change("pref-provider-effort", "xhigh");
    tab("translation");
    register();
    tab("providers");
    change("pref-auth-mode", "openai_compatible");
    assertDraft();
    assert.equal(
      getModelProviderConfiguration().providers[0].apiKey,
      "fake-saved-key",
    );
    assert.equal(
      getModelProviderConfiguration().providers[0].models[0].model,
      "saved-model",
    );
    change("pref-auth-mode", "codex_auth");
    assert.equal(field("pref-provider-effort").value, "xhigh");
    tab("translation");
    // Zotero may replace pane markup while retaining the preferences window.
    dom.window.document.body.innerHTML = template;
    register();
    assert.equal(
      dom.window.document
        .getElementById("papertranslateforzotero-translation-tab")!
        .getAttribute("aria-selected"),
      "true",
    );
    tab("providers");
    change("pref-auth-mode", "openai_compatible");
    assertDraft();
    dom.window.dispatchEvent(new dom.window.Event("unload"));
    dom.window.close();
    dom = new JSDOM(template);
    register();
    assertDraft();
    assert.equal(
      (dom.window.document.querySelector(".pt-provider-body") as HTMLElement)
        .hidden,
      false,
    );
    register();
    click("#papertranslateforzotero-add-provider");
    assert.equal(
      dom.window.document.querySelectorAll(".pt-provider-card").length,
      2,
    );
    (
      dom.window.document
        .querySelectorAll(".pt-provider-card")[1]
        .querySelector(".pt-danger-button") as HTMLElement
    ).click();
    click(".pt-save-button");
    assert.equal(
      getModelProviderConfiguration().providers[0].apiKey,
      "fake-draft-key",
    );
    assert.equal(getModelProviderConfiguration().activeModelId, "m");
    dom.window.dispatchEvent(new dom.window.Event("unload"));
    dom.window.close();
    dom = new JSDOM(template);
    register();
    assertDraft();
  } finally {
    dom.window.dispatchEvent(new dom.window.Event("unload"));
    dom.window.close();
  }
});
