import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { registerPrefsScripts } from "../src/modules/preferenceWindow";
import {
  getModelProviderConfiguration,
  setActiveModelId,
  setModelProviderConfiguration,
} from "../src/models/providers";
import { createModelSelectionActions } from "../src/models/selection";

test("settings preset selection, custom editing, save, text test and image test work through the real UI handlers", async () => {
  const template = await readFile(
    new URL("../addon/chrome/content/preferences.xhtml", import.meta.url),
    "utf8",
  );
  const dom = new JSDOM(
    template
      .replaceAll("__addonRef__", "papertranslateforzotero")
      .replaceAll("html:", ""),
  );
  const prefs = new Map<string, unknown>();
  let cancellations = 0;
  let requests = 0;
  let listingRequests = 0;
  let listingMode: "ok" | "error" | "delayed" = "ok";
  let resolveListing: ((response: Response) => void) | undefined;
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
    getGlobal: () => async (_url: string, init: RequestInit) => {
      if (init.method === "GET") {
        listingRequests += 1;
        if (listingMode === "error")
          return new Response("denied", { status: 403 });
        if (listingMode === "delayed")
          return new Promise<Response>((resolve) => {
            resolveListing = resolve;
          });
        return new Response(
          JSON.stringify({
            data: [
              { id: "example-model" },
              { id: "model-b", name: "<img src=x onerror=alert(1)>" },
              { id: "model-c", name: "Example C" },
              { id: "model-b" },
            ],
          }),
        );
      }
      requests += 1;
      const payload = JSON.parse(String(init.body));
      const text = payload.input[0].content.some(
        (part: any) => part.type === "input_image",
      )
        ? '{"text":"TEST 42"}'
        : "OK";
      return new Response(
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n`,
      );
    },
  };
  setModelProviderConfiguration(
    [
      {
        id: "p",
        name: "Example",
        authMode: "openai_compatible",
        apiBase: "https://api.openai.com/v1",
        apiKey: "fake-key",
        models: [{ id: "m", model: "example-model", effort: "" }],
      },
    ],
    "m",
  );
  const actions = createModelSelectionActions({
    getConfiguration: getModelProviderConfiguration,
    setActiveModelId,
    setConfiguration: setModelProviderConfiguration,
    cancelModelTasks() {
      cancellations += 1;
    },
  });
  const doc = dom.window.document;
  const control = (label: string) => {
    const result = doc.querySelector(`[aria-label="${label}"]`) as
      | HTMLInputElement
      | HTMLSelectElement;
    assert.ok(result, label);
    return result;
  };
  const change = (label: string, value: string) => {
    const node = control(label);
    node.value = value;
    node.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  };
  const input = (label: string, value: string) => {
    const node = control(label);
    node.value = value;
    node.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  const button = (text: string) => {
    const node = Array.from(doc.querySelectorAll("button")).find(
      (item) =>
        item.textContent === text || item.getAttribute("aria-label") === text,
    );
    assert.ok(node, text);
    return node;
  };
  try {
    registerPrefsScripts(dom.window as unknown as Window, actions);
    const card = doc.querySelector(".pt-provider-card")!;
    const cardToggle = card.querySelector(
      ".pt-provider-toggle",
    ) as HTMLButtonElement;
    assert.equal(cardToggle.getAttribute("aria-expanded"), "false");
    assert.equal(
      (card.querySelector(".pt-provider-body") as HTMLElement).hidden,
      true,
    );
    (card.querySelector(".pt-provider-chevron") as HTMLElement).click();
    assert.equal(cardToggle.getAttribute("aria-expanded"), "true");
    assert.equal(
      (card.querySelector(".pt-provider-body") as HTMLElement).hidden,
      false,
    );
    input("pref-provider-name", "Renamed provider");
    assert.equal(
      card.querySelector(".pt-provider-title")!.textContent,
      "Renamed provider",
    );
    cardToggle.click();
    cardToggle.click();
    assert.equal(control("pref-provider-name").value, "Renamed provider");
    const translationTab = doc.getElementById(
      "papertranslateforzotero-translation-tab",
    ) as HTMLButtonElement;
    const providersTab = doc.getElementById(
      "papertranslateforzotero-providers-tab",
    ) as HTMLButtonElement;
    translationTab.click();
    assert.equal(
      doc.getElementById("papertranslateforzotero-providers-panel")!.hidden,
      true,
    );
    translationTab.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "ArrowLeft",
        bubbles: true,
      }),
    );
    assert.equal(providersTab.getAttribute("aria-selected"), "true");
    assert.equal(
      doc.getElementById("papertranslateforzotero-providers-panel")!.hidden,
      false,
    );
    const assertSimpleSettings = () => {
      assert.equal(
        doc.querySelector("details"),
        null,
        "No advanced settings disclosure",
      );
      for (const label of [
        "pref-provider-workspace",
        "pref-provider-version",
        "pref-provider-max-tokens",
      ]) {
        assert.equal(doc.querySelector(`[aria-label="${label}"]`), null);
      }
      assert.equal(control("pref-provider-timeout").closest("details"), null);
      assert.equal(
        control("pref-provider-timeout").closest("section"),
        doc.querySelector("section"),
      );
    };
    assertSimpleSettings();
    assert.equal(
      (control("pref-provider-preset") as HTMLSelectElement).options.length,
      8,
    );
    change("pref-provider-preset", "openai-responses");
    assert.equal(
      control("pref-provider-api-base").value,
      "https://api.openai.com/v1/responses",
    );
    assert.equal(control("pref-provider-protocol").value, "responses");
    assert.equal(control("pref-provider-protocol").disabled, true);
    assert.equal(
      control("pref-provider-protocol").closest("label")!.hidden,
      true,
    );
    assert.equal(
      doc.querySelector(".pt-provider-toggle")!.getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(control("pref-provider-api-key").value, "fake-key");
    change("pref-provider-preset", "deepseek-chat");
    assert.equal(control("pref-provider-api-key").value, "");
    assert.equal(
      control("pref-provider-api-base").value,
      "https://api.deepseek.com/chat/completions",
    );
    change("pref-provider-preset", "custom");
    assert.equal(
      control("pref-provider-protocol").closest("label")!.hidden,
      false,
    );
    assert.equal(
      (control("pref-provider-api-base") as HTMLInputElement).readOnly,
      false,
    );
    input("pref-provider-api-base", "https://example.test/v1/chat/completions");
    change("pref-provider-protocol", "responses");
    assert.match(
      doc.querySelector('[aria-live="polite"]')!.textContent!,
      /不匹配/u,
    );
    input("pref-provider-api-base", "https://example.test/v1?api-version=2026");
    assert.match(
      doc.querySelector('[aria-live="polite"]')!.textContent!,
      /\/v1\/responses\?…/u,
    );
    input("pref-provider-api-key", "new-fake-key");
    input("pref-provider-timeout", "90");
    button("pref-provider-save").click();
    const saved = getModelProviderConfiguration();
    assert.equal(saved.providers[0].protocol, "responses");
    assert.equal(saved.providers[0].timeoutSeconds, 90);
    assert.equal(saved.providers[0].apiKey, "new-fake-key");
    assert.equal(saved.activeModelId, "m");
    assert.equal(cancellations, 1);
    assert.equal(requests, 0, "saving does not run a paid connection test");
    const testToggle = button("pref-provider-test");
    const testChoices = doc.querySelector(".pt-test-choices") as HTMLElement;
    assert.equal(testChoices.hidden, true);
    testToggle.click();
    assert.equal(testToggle.getAttribute("aria-expanded"), "true");
    assert.equal(testChoices.hidden, false);
    assert.equal(requests, 0, "opening test choices never sends a request");
    button("pref-codex-test").focus();
    button("pref-codex-test").dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }),
    );
    assert.equal(testChoices.hidden, true);
    assert.equal(doc.activeElement, testToggle);
    testToggle.click();
    button("pref-codex-test").click();
    assert.equal(testChoices.hidden, true);
    assert.equal(testToggle.getAttribute("aria-expanded"), "false");
    assert.equal(testToggle.disabled, true);
    await setImmediate();
    assert.equal(testToggle.disabled, false);
    assert.match(
      doc.querySelector(".papertranslateforzotero-provider-status")!
        .textContent!,
      /success: OK/u,
    );
    testToggle.click();
    button("pref-provider-image-test").click();
    await setImmediate();
    assert.match(
      doc.querySelector(".papertranslateforzotero-provider-status")!
        .textContent!,
      /success: TEST 42/u,
    );
    assert.equal(requests, 2);
    const options = button("pref-provider-model-options");
    assert.equal(options.getAttribute("aria-expanded"), "false");
    options.click();
    assert.equal(options.getAttribute("aria-expanded"), "true");
    assert.equal(
      (doc.querySelector(".pt-model-controls") as HTMLElement).hidden,
      false,
    );
    assert.equal(button("pref-provider-current").disabled, true);

    button("pref-provider-models-fetch").click();
    await setImmediate();
    let picker = doc.querySelector("dialog")!;
    assert.ok(picker?.hasAttribute("open"));
    assert.equal(
      picker.querySelectorAll('.pt-model-picker-row input[type="checkbox"]')
        .length,
      3,
    );
    assert.equal(
      (picker.querySelector('input[value="example-model"]') as HTMLInputElement)
        .disabled,
      true,
    );
    assert.equal(
      picker.querySelector("img"),
      null,
      "provider labels are plain text",
    );
    assert.equal(button("pref-provider-models-add-selected").disabled, true);
    const search = control("pref-provider-models-search");
    assert.equal(doc.activeElement, search);
    search.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
      }),
    );
    assert.equal(doc.activeElement, button("pref-provider-models-cancel"));
    picker.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    assert.equal(doc.querySelector("dialog"), null);
    assert.equal(doc.activeElement, button("pref-provider-models-fetch"));
    assert.equal(getModelProviderConfiguration().providers[0].models.length, 1);

    button("pref-provider-models-fetch").click();
    await setImmediate();
    picker = doc.querySelector("dialog")!;
    (
      picker.querySelector('input[value="model-c"]') as HTMLInputElement
    ).click();
    input("pref-provider-models-search", "model-b");
    assert.equal(
      Array.from(
        picker.querySelectorAll<HTMLElement>(".pt-model-picker-row"),
      ).filter((row) => !row.hidden).length,
      1,
    );
    (
      picker.querySelector('input[value="model-b"]') as HTMLInputElement
    ).click();
    button("pref-provider-models-add-selected").click();
    assert.equal(doc.querySelector("dialog"), null);
    assert.equal(doc.querySelectorAll(".pt-provider-model-row").length, 3);
    assert.equal(
      getModelProviderConfiguration().providers[0].models.length,
      1,
      "choosing models changes only the draft",
    );
    assert.equal(getModelProviderConfiguration().activeModelId, "m");
    button("pref-provider-save").click();
    assert.equal(getModelProviderConfiguration().providers[0].models.length, 3);
    assert.equal(
      getModelProviderConfiguration().activeModelId,
      "m",
      "discovery never changes the active model",
    );
    assert.equal(requests, 2, "discovery never generates text or tests models");
    assert.equal(listingRequests, 2);

    listingMode = "error";
    button("pref-provider-models-fetch").click();
    await setImmediate();
    assert.equal(doc.querySelector("dialog"), null);
    assert.match(doc.querySelector(".pt-provider-status")!.textContent!, /403/);
    assert.equal(button("pref-provider-add-model").disabled, false);

    listingMode = "delayed";
    button("pref-provider-models-fetch").click();
    await setImmediate();
    assert.equal(button("pref-provider-models-fetch").disabled, true);
    input("pref-provider-api-key", "edited-fake-key");
    await setImmediate();
    assert.equal(button("pref-provider-models-fetch").disabled, false);
    assert.equal(
      (doc.querySelector(".pt-provider-status") as HTMLElement).hidden,
      true,
    );
    resolveListing!(
      new Response(JSON.stringify({ data: [{ id: "late-model" }] })),
    );
    await setImmediate();
    assert.equal(
      doc.querySelector("dialog"),
      null,
      "late results from an old API key are discarded",
    );
    for (const preset of [
      "anthropic-messages",
      "anthropic-chat",
      "deepseek-chat",
    ]) {
      change("pref-provider-preset", preset);
      assertSimpleSettings();
    }
    const anthropicOption = doc.querySelector('option[value="anthropic-chat"]');
    assert.equal(
      anthropicOption?.textContent,
      "Anthropic · Chat Completions（兼容）",
    );
    change("pref-auth-mode", "codex_auth");
    assertSimpleSettings();
    assert.equal(doc.querySelector(".pt-fetch-models"), null);
    (
      doc.getElementById(
        "papertranslateforzotero-add-provider",
      ) as HTMLButtonElement
    ).click();
    assert.equal(doc.querySelectorAll(".pt-provider-card").length, 2);
    let newCard = doc.querySelectorAll(".pt-provider-card")[1];
    assert.equal(
      newCard
        .querySelector(".pt-provider-toggle")!
        .getAttribute("aria-expanded"),
      "true",
    );
    const newPreset = newCard.querySelector(
      '[aria-label="pref-provider-preset"]',
    ) as HTMLSelectElement;
    newPreset.value = "openai-responses";
    newPreset.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    newCard = doc.querySelectorAll(".pt-provider-card")[1];
    const newKey = newCard.querySelector(
      '[aria-label="pref-provider-api-key"]',
    ) as HTMLInputElement;
    newKey.value = "new-provider-fake-key";
    newKey.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    listingMode = "ok";
    (newCard.querySelector(".pt-fetch-models") as HTMLButtonElement).click();
    await setImmediate();
    picker = doc.querySelector("dialog")!;
    (
      picker.querySelector('input[value="model-b"]') as HTMLInputElement
    ).click();
    button("pref-provider-models-add-selected").click();
    newCard = doc.querySelectorAll(".pt-provider-card")[1];
    assert.equal(
      newCard.querySelectorAll(".pt-provider-model-row").length,
      1,
      "discovery replaces a new provider's empty placeholder",
    );
    assert.equal(
      (newCard.querySelector(".pt-model-input") as HTMLInputElement).value,
      "model-b",
    );
    (newCard.querySelector(".pt-danger-button") as HTMLButtonElement).click();
    assert.equal(doc.querySelectorAll(".pt-provider-card").length, 1);
  } finally {
    dom.window.dispatchEvent(new dom.window.Event("unload"));
    dom.window.close();
  }
});
