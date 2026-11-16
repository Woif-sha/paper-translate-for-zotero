import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { registerPrefsScripts } from "../src/modules/preferenceWindow";
import { createModelSelectionActions } from "../src/models/selection";
import {
  getModelProviderConfiguration,
  setActiveModelId,
  setModelProviderConfiguration,
} from "../src/models/providers";

async function setup() {
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
    getGlobal: () => async (_url: string, init: RequestInit) => {
      assert.equal(init.method, "GET", "drafts must not generate model output");
      return new Response(JSON.stringify({ data: [{ id: "saved-model" }] }));
    },
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
  return { template, actions };
}

for (const field of ["api-key", "api-base", "model"] as const) {
  for (const outcome of ["success", "failure"] as const) {
    test(`editing ${field} cancels its pending connection test and discards the old ${outcome}`, async () => {
      const { template, actions } = await setup();
      const configuration = getModelProviderConfiguration();
      configuration.providers[0].presetId = "custom";
      setModelProviderConfiguration(
        configuration.providers,
        configuration.activeModelId,
      );
      const dom = new JSDOM(template);
      let signal: AbortSignal | undefined;
      let respond: ((response: Response) => void) | undefined;
      (globalThis as any).ztoolkit = {
        getGlobal: () => async (_url: string, init: RequestInit) => {
          if (init.method === "GET")
            return new Response(
              JSON.stringify({ data: [{ id: "saved-model" }] }),
            );
          signal = init.signal as AbortSignal;
          return new Promise<Response>((resolve) => {
            respond = resolve;
          });
        },
      };
      const doc = dom.window.document;
      try {
        registerPrefsScripts(dom.window as unknown as Window, actions);
        if (field === "model") {
          const select = doc.querySelector(
            ".pt-provider-model-select",
          ) as HTMLSelectElement;
          select.selectedIndex = select.options.length - 1;
          select.dispatchEvent(
            new dom.window.Event("change", { bubbles: true }),
          );
          await setImmediate();
        }
        (doc.querySelector(".pt-test-toggle") as HTMLButtonElement).click();
        (
          doc.querySelector(".pt-test-choices button") as HTMLButtonElement
        ).click();
        await setImmediate();
        assert.ok(respond);
        const input = doc.querySelector(
          field === "model"
            ? ".pt-model-input"
            : `[aria-label="pref-provider-${field}"]`,
        ) as HTMLInputElement;
        input.value =
          field === "api-base"
            ? "https://new.example.com/v1/responses"
            : "new-untested-value";
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        respond(
          outcome === "success"
            ? new Response(
                'data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
              )
            : new Response("Old configuration failed", { status: 401 }),
        );
        await setImmediate();
        assert.equal(signal?.aborted, true);
        assert.equal(
          (doc.querySelector(".pt-provider-status") as HTMLElement).hidden,
          true,
        );
        assert.equal(
          (doc.querySelector(".pt-test-toggle") as HTMLButtonElement).disabled,
          false,
        );
      } finally {
        dom.window.dispatchEvent(new dom.window.Event("unload"));
        dom.window.close();
      }
    });
  }
}

test("editing connection fields clears a completed connection test result", async () => {
  const { template, actions } = await setup();
  const configuration = getModelProviderConfiguration();
  configuration.providers[0].presetId = "custom";
  setModelProviderConfiguration(
    configuration.providers,
    configuration.activeModelId,
  );
  const dom = new JSDOM(template);
  (globalThis as any).ztoolkit = {
    getGlobal: () => async (_url: string, init: RequestInit) =>
      init.method === "GET"
        ? new Response(JSON.stringify({ data: [{ id: "saved-model" }] }))
        : new Response(
            'data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
          ),
  };
  const doc = dom.window.document;
  try {
    registerPrefsScripts(dom.window as unknown as Window, actions);
    const select = doc.querySelector(
      ".pt-provider-model-select",
    ) as HTMLSelectElement;
    select.selectedIndex = select.options.length - 1;
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await setImmediate();
    for (const field of [
      "api-key",
      "api-base",
      "model",
      "catalog-model",
    ] as const) {
      (doc.querySelector(".pt-test-toggle") as HTMLButtonElement).click();
      (
        doc.querySelector(".pt-test-choices button") as HTMLButtonElement
      ).click();
      await setImmediate();
      const status = doc.querySelector(".pt-provider-status") as HTMLElement;
      assert.match(status.textContent!, /success: OK/u);
      assert.equal(status.hidden, false);
      if (field === "catalog-model") {
        (doc.querySelector(".pt-model-input") as HTMLInputElement).blur();
        (
          doc.querySelector(".pt-provider-model-refresh") as HTMLButtonElement
        ).click();
        await setImmediate();
        select.value = "saved-model";
        select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
        await setImmediate();
        assert.equal(
          status.hidden,
          true,
          "picking a catalog model must invalidate the completed result",
        );
        continue;
      }
      const input = doc.querySelector(
        field === "model"
          ? ".pt-model-input"
          : `[aria-label="pref-provider-${field}"]`,
      ) as HTMLInputElement;
      input.value =
        field === "api-base"
          ? "https://new.example.com/v1/responses"
          : "new-untested-value";
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      assert.equal(
        status.hidden,
        true,
        `${field} must invalidate the completed result`,
      );
    }
  } finally {
    dom.window.dispatchEvent(new dom.window.Event("unload"));
    dom.window.close();
  }
});

test("an older connection test cannot re-enable the button for its replacement", async () => {
  const { template, actions } = await setup();
  const dom = new JSDOM(template);
  const requests: { signal: AbortSignal; respond(response: Response): void }[] =
    [];
  (globalThis as any).ztoolkit = {
    getGlobal: () => async (_url: string, init: RequestInit) => {
      if (init.method === "GET")
        return new Response(JSON.stringify({ data: [{ id: "saved-model" }] }));
      return new Promise<Response>((respond) => {
        requests.push({ signal: init.signal as AbortSignal, respond });
      });
    },
  };
  const doc = dom.window.document;
  const startTest = () => {
    (doc.querySelector(".pt-test-toggle") as HTMLButtonElement).click();
    (doc.querySelector(".pt-test-choices button") as HTMLButtonElement).click();
  };
  try {
    registerPrefsScripts(dom.window as unknown as Window, actions);
    startTest();
    await setImmediate();
    const key = doc.querySelector(
      '[aria-label="pref-provider-api-key"]',
    ) as HTMLInputElement;
    key.value = "replacement-key";
    key.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    startTest();
    await setImmediate();
    assert.equal(requests.length, 2);
    assert.equal(requests[0].signal.aborted, true);
    requests[0].respond(
      new Response("Old configuration failed", { status: 401 }),
    );
    await setImmediate();
    const toggle = doc.querySelector(".pt-test-toggle") as HTMLButtonElement;
    assert.equal(toggle.disabled, true);
    assert.equal(
      doc.querySelector(".pt-provider-status")!.textContent,
      "pref-codex-testing",
    );
    requests[1].respond(
      new Response(
        'data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      ),
    );
    await setImmediate();
    assert.equal(toggle.disabled, false);
    assert.match(
      doc.querySelector(".pt-provider-status")!.textContent!,
      /success: OK/u,
    );
  } finally {
    dom.window.dispatchEvent(new dom.window.Event("unload"));
    dom.window.close();
  }
});

test("connection tests keep card ownership when another provider is edited or tested", async () => {
  const { template, actions } = await setup();
  const configuration = getModelProviderConfiguration();
  configuration.providers.push({
    ...configuration.providers[0],
    id: "second-provider",
    name: "Second provider",
    models: [{ id: "second-model", model: "saved-model", effort: "" }],
  });
  setModelProviderConfiguration(
    configuration.providers,
    configuration.activeModelId,
  );
  const dom = new JSDOM(template);
  const requests: { signal: AbortSignal; respond(response: Response): void }[] =
    [];
  (globalThis as any).ztoolkit = {
    getGlobal: () => async (_url: string, init: RequestInit) => {
      if (init.method === "GET")
        return new Response(JSON.stringify({ data: [{ id: "saved-model" }] }));
      return new Promise<Response>((respond) => {
        requests.push({ signal: init.signal as AbortSignal, respond });
      });
    },
  };
  const doc = dom.window.document;
  try {
    registerPrefsScripts(dom.window as unknown as Window, actions);
    const [first, second] = Array.from(
      doc.querySelectorAll<HTMLElement>(".pt-provider-card"),
    );
    (first.querySelector(".pt-test-toggle") as HTMLButtonElement).click();
    (
      first.querySelector(".pt-test-choices button") as HTMLButtonElement
    ).click();
    await setImmediate();
    const secondKey = second.querySelector(
      '[aria-label="pref-provider-api-key"]',
    ) as HTMLInputElement;
    secondKey.value = "second-key";
    secondKey.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.equal(requests[0].signal.aborted, false);
    assert.equal(
      first.querySelector(".pt-provider-status")!.textContent,
      "pref-codex-testing",
    );
    (second.querySelector(".pt-test-toggle") as HTMLButtonElement).click();
    (
      second.querySelectorAll(".pt-test-choices button")[1] as HTMLButtonElement
    ).click();
    await setImmediate();
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(
      (first.querySelector(".pt-provider-status") as HTMLElement).hidden,
      true,
    );
    assert.equal(
      (first.querySelector(".pt-test-toggle") as HTMLButtonElement).disabled,
      false,
    );
    requests[0].respond(
      new Response("Old configuration failed", { status: 401 }),
    );
    requests[1].respond(
      new Response(
        'data: {"type":"response.output_text.delta","delta":"{\\"text\\":\\"TEST 42\\"}"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      ),
    );
    await setImmediate();
    assert.match(
      second.querySelector(".pt-provider-status")!.textContent!,
      /success: TEST 42/u,
    );
  } finally {
    dom.window.dispatchEvent(new dom.window.Event("unload"));
    dom.window.close();
  }
});

for (const authMode of ["openai_compatible", "codex_auth"] as const) {
  test(`${authMode} model rows automatically load a shared newest-first catalog and explicitly refresh it`, async () => {
    const { template, actions } = await setup();
    const configuration = getModelProviderConfiguration();
    const provider = configuration.providers[0];
    provider.authMode = authMode;
    if (authMode === "codex_auth") {
      provider.apiBase = "https://chatgpt.com/backend-api/codex/responses";
      provider.models[0].effort = "high";
    }
    provider.models.push({ id: "m2", model: "second-saved", effort: "medium" });
    setModelProviderConfiguration(configuration.providers, "m");
    const previousServices = (globalThis as any).Services;
    const previousIO = (globalThis as any).IOUtils;
    let requests = 0;
    (globalThis as any).Services = { env: { get: () => "C:/fake-codex" } };
    (globalThis as any).IOUtils = {
      read: async () =>
        new TextEncoder().encode(
          JSON.stringify({ tokens: { access_token: "fake-codex-access" } }),
        ),
      write: async () => assert.fail("valid access tokens do not refresh"),
    };
    (globalThis as any).ztoolkit = {
      getGlobal: () => async (url: string, init: RequestInit) => {
        requests += 1;
        assert.equal(init.method, "GET");
        assert.equal(init.body, undefined);
        assert.equal(
          url,
          authMode === "codex_auth"
            ? "https://chatgpt.com/backend-api/codex/models?client_version=0.162.1"
            : "https://api.openai.com/v1/models",
        );
        return new Response(
          JSON.stringify(
            authMode === "codex_auth"
              ? {
                  models: [
                    { slug: "gpt-5.6", visibility: "list", priority: 100 },
                    {
                      slug: "detected-model",
                      display_name: "Detected model",
                      visibility: "list",
                    },
                    { slug: "gpt-6.1-sol", visibility: "list", priority: 0 },
                  ],
                }
              : {
                  data: [
                    { id: "gpt-5.6", created: 1 },
                    { id: "detected-model" },
                    { id: "gpt-6.1-sol", created: 2 },
                  ],
                },
          ),
        );
      },
    };
    const dom = new JSDOM(template);
    const doc = dom.window.document;
    try {
      registerPrefsScripts(dom.window as unknown as Window, actions);
      assert.equal(
        requests,
        0,
        "preloading waits for connection edits to settle",
      );
      const fields = Array.from(
        doc.querySelectorAll<HTMLInputElement>(".pt-model-input"),
      );
      const selectors = Array.from(
        doc.querySelectorAll<HTMLSelectElement>(".pt-provider-model-select"),
      );
      assert.equal(selectors.length, 2);
      assert.equal(selectors[0].value, "saved-model");
      assert.equal(fields[0].hidden, true);
      await new Promise((resolve) => setTimeout(resolve, 350));
      await setImmediate();
      assert.equal(
        requests,
        1,
        "no refresh button is needed to populate models",
      );
      for (const select of selectors) {
        assert.equal(select.options[0].value, "gpt-6.1-sol");
        assert.ok(
          Array.from(select.options).some(
            (option) => option.value === "detected-model",
          ),
          "one detected catalog feeds every model row",
        );
      }
      assert.equal(selectors[0].value, "saved-model");
      (doc.querySelector(".pt-provider-model-refresh") as HTMLElement).click();
      await setImmediate();
      assert.equal(requests, 2, "refresh bypasses the loaded catalog");
      selectors[0].value = "detected-model";
      selectors[0].dispatchEvent(
        new dom.window.Event("change", { bubbles: true }),
      );
      await setImmediate();
      assert.equal(fields[0].value, "detected-model");
      assert.equal(fields[0].hidden, true);
      assert.equal(selectors[1].value, "second-saved");
      assert.equal(
        getModelProviderConfiguration().providers[0].models[0].model,
        "saved-model",
      );
      assert.equal(getModelProviderConfiguration().activeModelId, "m");
      selectors[1].focus();
      await setImmediate();
      assert.equal(requests, 2, "another row reuses the detected catalog");
      selectors[1].blur();
      (doc.querySelector(".pt-save-button") as HTMLElement).click();
      const saved = getModelProviderConfiguration();
      assert.equal(saved.providers[0].models[0].model, "detected-model");
      assert.equal(saved.providers[0].models[0].id, "m");
      assert.equal(saved.activeModelId, "m");
      if (authMode === "codex_auth") {
        assert.equal(saved.providers[0].models[0].effort, "high");
      }
      assert.equal(
        (doc.querySelector(".pt-provider-model-select") as HTMLSelectElement)
          .value,
        "detected-model",
      );
    } finally {
      dom.window.dispatchEvent(new dom.window.Event("unload"));
      dom.window.close();
      (globalThis as any).Services = previousServices;
      (globalThis as any).IOUtils = previousIO;
    }
  });
}

test("completing or editing connection fields automatically loads the matching catalog without saving", async () => {
  const { template, actions } = await setup();
  const requests: string[] = [];
  (globalThis as any).ztoolkit = {
    getGlobal: () => async (_url: string, init: RequestInit) => {
      assert.equal(init.method, "GET");
      const authorization = (init.headers as Record<string, string>)
        .Authorization;
      requests.push(authorization);
      return new Response(
        JSON.stringify({
          data: [
            {
              id:
                authorization === "Bearer fake-auto-key"
                  ? "first-auto-model"
                  : "second-auto-model",
            },
          ],
        }),
      );
    },
  };
  const dom = new JSDOM(template);
  const doc = dom.window.document;
  const editKey = (value: string) => {
    const key = doc.querySelector(
      '[aria-label="pref-provider-api-key"]',
    ) as HTMLInputElement;
    key.value = value;
    key.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  const options = () =>
    Array.from(
      (doc.querySelector(".pt-provider-model-select") as HTMLSelectElement)
        .options,
    ).map((option) => option.value);
  try {
    registerPrefsScripts(dom.window as unknown as Window, actions);
    editKey("");
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.deepEqual(requests, [], "incomplete credentials are not sent");
    editKey("fake-auto-key");
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.deepEqual(requests, ["Bearer fake-auto-key"]);
    assert.ok(options().includes("first-auto-model"));
    editKey("fake-next-key");
    assert.equal(options().includes("first-auto-model"), false);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.deepEqual(requests, [
      "Bearer fake-auto-key",
      "Bearer fake-next-key",
    ]);
    assert.ok(options().includes("second-auto-model"));
    assert.equal(options().includes("first-auto-model"), false);
    assert.equal(
      getModelProviderConfiguration().providers[0].apiKey,
      "fake-saved-key",
    );
    assert.equal(getModelProviderConfiguration().activeModelId, "m");
  } finally {
    dom.window.dispatchEvent(new dom.window.Event("unload"));
    dom.window.close();
  }
});

test("settings windows keep provider and model expansion independent across clicks and shared renders", async () => {
  const { template, actions } = await setup();
  const first = new JSDOM(template);
  const second = new JSDOM(template);
  const node = (dom: JSDOM, selector: string) =>
    dom.window.document.querySelector(selector) as HTMLElement;
  const click = (dom: JSDOM, selector: string) => node(dom, selector).click();
  const assertView = (
    dom: JSDOM,
    providerOpen: boolean,
    modelOpen: boolean,
  ) => {
    assert.equal(node(dom, ".pt-provider-body").hidden, !providerOpen);
    assert.equal(
      node(dom, ".pt-provider-toggle").getAttribute("aria-expanded"),
      String(providerOpen),
    );
    assert.equal(node(dom, ".pt-model-controls").hidden, !modelOpen);
    assert.equal(
      node(dom, ".pt-model-options").getAttribute("aria-expanded"),
      String(modelOpen),
    );
  };
  try {
    registerPrefsScripts(first.window as unknown as Window, actions);
    registerPrefsScripts(second.window as unknown as Window, actions);
    assertView(first, false, false);
    assertView(second, false, false);
    click(first, ".pt-provider-toggle");
    assertView(first, true, false);
    assertView(second, false, false);
    click(second, ".pt-provider-toggle");
    assertView(second, true, false);
    click(first, ".pt-model-options");
    assertView(first, true, true);
    assertView(second, true, false);
    click(second, ".pt-model-options");
    assertView(second, true, true);
    click(first, ".pt-model-options");
    click(first, ".pt-provider-toggle");
    assertView(first, false, false);
    assertView(second, true, true);
    const name = node(
      second,
      '[aria-label="pref-provider-name"]',
    ) as HTMLInputElement;
    name.value = "Shared edit with separate expansion";
    name.dispatchEvent(new second.window.Event("input", { bubbles: true }));
    assertView(first, false, false);
    assertView(second, true, true);
    click(second, ".pt-save-button");
    assertView(first, false, false);
    assertView(second, true, true);
    click(first, ".pt-provider-toggle");
    click(second, ".pt-provider-toggle");
    assertView(first, true, false);
    assertView(second, false, true);
  } finally {
    for (const dom of [first, second]) {
      dom.window.dispatchEvent(new dom.window.Event("unload"));
      dom.window.close();
    }
  }
});

test("pane reconstruction keeps its window view and closing or changing tabs preserves the latest expansion memory", async () => {
  const { template, actions } = await setup();
  const first = new JSDOM(template);
  const second = new JSDOM(template);
  const reopened = new JSDOM(template);
  const click = (dom: JSDOM, selector: string) =>
    (dom.window.document.querySelector(selector) as HTMLElement).click();
  const assertExpansion = (dom: JSDOM, open: boolean) => {
    for (const selector of [".pt-provider-body", ".pt-model-controls"]) {
      assert.equal(
        (dom.window.document.querySelector(selector) as HTMLElement).hidden,
        !open,
      );
    }
  };
  const close = (dom: JSDOM) => {
    dom.window.dispatchEvent(new dom.window.Event("unload"));
    dom.window.close();
  };
  try {
    registerPrefsScripts(first.window as unknown as Window, actions);
    registerPrefsScripts(second.window as unknown as Window, actions);
    click(first, ".pt-provider-toggle");
    click(first, ".pt-model-options");
    click(second, "#papertranslateforzotero-translation-tab");
    second.window.document.body.innerHTML = template;
    registerPrefsScripts(second.window as unknown as Window, actions);
    assertExpansion(first, true);
    assertExpansion(second, false);
    assert.equal(
      second.window.document
        .getElementById("papertranslateforzotero-translation-tab")!
        .getAttribute("aria-selected"),
      "true",
    );
    close(first);
    close(second);
    registerPrefsScripts(reopened.window as unknown as Window, actions);
    assertExpansion(reopened, true);
    assert.equal(
      reopened.window.document
        .getElementById("papertranslateforzotero-translation-tab")!
        .getAttribute("aria-selected"),
      "true",
    );
  } finally {
    close(first);
    close(second);
    close(reopened);
  }
});

test("unedited windows and tab changes cannot overwrite another window's newer draft", async () => {
  const { template, actions } = await setup();
  const first = new JSDOM(template);
  const second = new JSDOM(template);
  const reopened = new JSDOM(template);
  const close = (dom: JSDOM) => {
    dom.window.dispatchEvent(new dom.window.Event("unload"));
    dom.window.close();
  };
  try {
    registerPrefsScripts(first.window as unknown as Window, actions);
    registerPrefsScripts(second.window as unknown as Window, actions);
    for (const [label, value] of [
      ["pref-provider-name", "Newer draft name"],
      ["pref-provider-api-key", "fake-newer-draft-key"],
    ]) {
      const field = first.window.document.querySelector(
        `[aria-label="${label}"]`,
      ) as HTMLInputElement;
      field.value = value;
      field.dispatchEvent(new first.window.Event("input", { bubbles: true }));
    }
    (
      second.window.document.getElementById(
        "papertranslateforzotero-translation-tab",
      ) as HTMLButtonElement
    ).click();
    close(first);
    close(second);
    registerPrefsScripts(reopened.window as unknown as Window, actions);
    const field = (label: string) =>
      reopened.window.document.querySelector(
        `[aria-label="${label}"]`,
      ) as HTMLInputElement;
    assert.equal(field("pref-provider-name").value, "Newer draft name");
    assert.equal(field("pref-provider-api-key").value, "fake-newer-draft-key");
    assert.equal(
      getModelProviderConfiguration().providers[0].apiKey,
      "fake-saved-key",
      "remembering a shared draft does not apply it",
    );
  } finally {
    close(first);
    close(second);
    close(reopened);
  }
});

for (const operation of ["catalog", "text-test", "picker"] as const) {
  test(`opening and closing another settings window leaves the first window's ${operation} intact`, async () => {
    const { template, actions } = await setup();
    const first = new JSDOM(template);
    const second = new JSDOM(template);
    let requestSignal: AbortSignal | undefined;
    let primarySignal: AbortSignal | undefined;
    let respond: ((response: Response) => void) | undefined;
    const catalogResponse = () =>
      new Response(JSON.stringify({ data: [{ id: "listed-model" }] }));
    (globalThis as any).ztoolkit = {
      getGlobal: () => async (_url: string, init: RequestInit) => {
        requestSignal = init.signal as AbortSignal;
        if (operation === "picker") return catalogResponse();
        return new Promise<Response>((resolve) => {
          respond = resolve;
        });
      },
    };
    const doc = first.window.document;
    const assertOperationActive = () => {
      if (operation === "picker") {
        assert.ok(doc.querySelector("dialog")?.hasAttribute("open"));
      } else {
        assert.equal(primarySignal?.aborted, false);
      }
    };
    try {
      registerPrefsScripts(first.window as unknown as Window, actions);
      if (operation === "text-test") {
        (doc.querySelector(".pt-test-toggle") as HTMLButtonElement).click();
        (
          doc.querySelector(".pt-test-choices button") as HTMLButtonElement
        ).click();
      } else {
        (doc.querySelector(".pt-fetch-models") as HTMLButtonElement).click();
      }
      await setImmediate();
      primarySignal = requestSignal;
      const respondToPrimary = respond;
      assertOperationActive();
      registerPrefsScripts(second.window as unknown as Window, actions);
      await setImmediate();
      assertOperationActive();
      second.window.dispatchEvent(new second.window.Event("unload"));
      await setImmediate();
      assertOperationActive();
      if (operation === "catalog") {
        respondToPrimary!(catalogResponse());
        await setImmediate();
        assert.ok(doc.querySelector("dialog")?.hasAttribute("open"));
      } else if (operation === "text-test") {
        respondToPrimary!(
          new Response(
            'data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
          ),
        );
        await setImmediate();
        assert.match(
          doc.querySelector(".pt-provider-status")!.textContent!,
          /success: OK/u,
        );
      }
    } finally {
      for (const dom of [first, second]) {
        dom.window.dispatchEvent(new dom.window.Event("unload"));
        dom.window.close();
      }
    }
  });
}

test("another editor can keep editing the shared draft after a window saves it", async () => {
  const { template, actions } = await setup();
  const first = new JSDOM(template);
  const second = new JSDOM(template);
  try {
    registerPrefsScripts(first.window as unknown as Window, actions);
    registerPrefsScripts(second.window as unknown as Window, actions);
    (
      first.window.document.querySelector(
        ".pt-save-button",
      ) as HTMLButtonElement
    ).click();
    const name = second.window.document.querySelector(
      '[aria-label="pref-provider-name"]',
    ) as HTMLInputElement;
    name.value = "Edited after another window saved";
    name.dispatchEvent(new second.window.Event("input", { bubbles: true }));
    (
      second.window.document.querySelector(
        ".pt-save-button",
      ) as HTMLButtonElement
    ).click();
    assert.equal(
      getModelProviderConfiguration().providers[0].name,
      "Edited after another window saved",
    );
  } finally {
    for (const dom of [first, second]) {
      dom.window.dispatchEvent(new dom.window.Event("unload"));
      dom.window.close();
    }
  }
});

test("draft fields survive auth changes, tab changes, pane reconstruction and reopening without applying them", async () => {
  const { template, actions } = await setup();
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

test("an external save replaces an open editor's stale draft before it can restore old credentials", async () => {
  const { template, actions } = await setup();
  const dom = new JSDOM(template);
  const doc = dom.window.document;
  const field = (key: string) =>
    doc.querySelector(`[aria-label="${key}"]`) as HTMLInputElement;
  try {
    registerPrefsScripts(dom.window as unknown as Window, actions);
    const name = field("pref-provider-name");
    name.value = "Stale draft";
    name.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const saved = getModelProviderConfiguration();
    saved.providers[0].name = "Saved elsewhere";
    saved.providers[0].apiKey = "fake-updated-key";
    saved.providers[0].models[0].model = "updated-model";
    setModelProviderConfiguration(saved.providers, saved.activeModelId);
    assert.equal(field("pref-provider-name").value, "Saved elsewhere");
    assert.equal(field("pref-provider-api-key").value, "fake-updated-key");
    assert.equal(field("pref-provider-model-id").value, "updated-model");
    (doc.querySelector(".pt-save-button") as HTMLButtonElement).click();
    assert.equal(
      getModelProviderConfiguration().providers[0].apiKey,
      "fake-updated-key",
    );
    assert.equal(
      getModelProviderConfiguration().providers[0].name,
      "Saved elsewhere",
    );
  } finally {
    dom.window.dispatchEvent(new dom.window.Event("unload"));
    dom.window.close();
  }
});

test("switching only the active model keeps an open editor's unfinished draft", async () => {
  const { template, actions } = await setup();
  const saved = getModelProviderConfiguration();
  saved.providers[0].models.push({
    id: "m2",
    model: "other-model",
    effort: "",
  });
  setModelProviderConfiguration(saved.providers, saved.activeModelId);
  const dom = new JSDOM(template);
  const doc = dom.window.document;
  const field = (key: string) =>
    doc.querySelector(`[aria-label="${key}"]`) as HTMLInputElement;
  try {
    registerPrefsScripts(dom.window as unknown as Window, actions);
    const key = field("pref-provider-api-key");
    key.value = "fake-draft-key";
    key.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    setActiveModelId("m2");
    assert.equal(field("pref-provider-api-key").value, "fake-draft-key");
    assert.equal(
      getModelProviderConfiguration().providers[0].apiKey,
      "fake-saved-key",
    );
    assert.equal(
      doc
        .querySelector(".pt-model-controls button:disabled")
        ?.closest(".pt-provider-model")
        ?.querySelector("input")?.value,
      "other-model",
    );
  } finally {
    dom.window.dispatchEvent(new dom.window.Event("unload"));
    dom.window.close();
  }
});

test("the editor's own synchronous save notifications preserve auth and preset connection memory", async () => {
  const { template, actions } = await setup();
  const dom = new JSDOM(template);
  const doc = dom.window.document;
  const field = (key: string) =>
    doc.querySelector(`[aria-label="${key}"]`) as
      | HTMLInputElement
      | HTMLSelectElement;
  const change = (key: string, value: string) => {
    const node = field(key);
    node.value = value;
    node.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  };
  const save = () =>
    (doc.querySelector(".pt-save-button") as HTMLButtonElement).click();
  try {
    registerPrefsScripts(dom.window as unknown as Window, actions);
    change("pref-provider-preset", "deepseek-chat");
    const key = field("pref-provider-api-key");
    key.value = "fake-deepseek-key";
    key.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    change("pref-auth-mode", "codex_auth");
    change("pref-provider-effort", "xhigh");
    save();
    assert.equal(
      getModelProviderConfiguration().providers[0].authMode,
      "codex_auth",
    );
    change("pref-auth-mode", "openai_compatible");
    assert.equal(field("pref-provider-api-key").value, "fake-deepseek-key");
    change("pref-provider-preset", "openai-responses");
    assert.equal(field("pref-provider-api-key").value, "fake-saved-key");
    save();
    assert.equal(
      getModelProviderConfiguration().providers[0].authMode,
      "openai_compatible",
    );
    change("pref-auth-mode", "codex_auth");
    assert.equal(field("pref-provider-effort").value, "xhigh");
    change("pref-auth-mode", "openai_compatible");
    change("pref-provider-preset", "deepseek-chat");
    assert.equal(field("pref-provider-api-key").value, "fake-deepseek-key");
  } finally {
    dom.window.dispatchEvent(new dom.window.Event("unload"));
    dom.window.close();
  }
});
