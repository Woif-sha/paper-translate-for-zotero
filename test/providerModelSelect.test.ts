import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { attachProviderModelSelect } from "../src/modules/providerModelSelect";
import type { DiscoveredModel } from "../src/models/modelDiscovery";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(
  options: {
    saved?: string;
    initialModels?: DiscoveredModel[];
    canAutoLoad?: () => boolean;
    loadModels?: (options?: { force?: boolean }) => Promise<DiscoveredModel[]>;
  } = {},
) {
  const dom = new JSDOM('<main><input aria-label="original-model-id"></main>');
  (globalThis as any).addon = {
    data: {
      locale: {
        current: {
          formatMessagesSync: (items: any[]) =>
            items.map((entry) => ({
              value:
                entry.id.replace("papertranslateforzotero-", "") +
                (entry.args?.count === undefined ? "" : `:${entry.args.count}`),
            })),
        },
      },
    },
  };
  const doc = dom.window.document;
  const input = doc.querySelector("input")!;
  input.value = options.saved ?? "";
  const calls: Array<{ force?: boolean } | undefined> = [];
  const picked: string[] = [];
  const component = attachProviderModelSelect({
    input,
    initialModels: options.initialModels,
    canAutoLoad: options.canAutoLoad ?? (() => false),
    loadModels: (loadOptions) => {
      calls.push(loadOptions);
      return options.loadModels?.(loadOptions) ?? Promise.resolve([]);
    },
    onModelPicked: (id) => picked.push(id),
  });
  doc.querySelector("main")!.append(component.container, component.details);
  const select = component.container.querySelector("select")!;
  const refresh = component.container.querySelector("button")!;
  const showAll = component.details.querySelector("input")!;
  const status = component.details.querySelector("[role=status]")!;
  return {
    dom,
    doc,
    input,
    select,
    refresh,
    showAll,
    status,
    component,
    calls,
    picked,
    values: () => Array.from(select.options).map((option) => option.value),
    modelValues: () =>
      Array.from(select.options)
        .slice(0, -1)
        .map((option) => option.value),
    change(value: string) {
      select.value = value;
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    },
    customize() {
      this.change(select.options[select.options.length - 1].value);
    },
    focusSelect() {
      select.dispatchEvent(new dom.window.Event("focus"));
    },
    blurSelect() {
      select.dispatchEvent(new dom.window.Event("blur"));
    },
    mouseDown() {
      const event = new dom.window.MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
      });
      select.dispatchEvent(event);
      return event;
    },
    dispose() {
      component.dispose();
      dom.window.close();
    },
  };
}

async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("complete settings automatically load a catalog after editing settles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const request = deferred<DiscoveredModel[]>();
  const f = fixture({
    saved: "saved-model",
    canAutoLoad: () => true,
    loadModels: () => request.promise,
  });
  try {
    assert.equal(f.calls.length, 0);
    t.mock.timers.tick(299);
    assert.equal(f.calls.length, 0);
    t.mock.timers.tick(1);
    assert.deepEqual(f.calls, [undefined]);
    assert.equal(f.select.disabled, true);
    assert.equal(f.status.textContent, "pref-provider-models-fetching");
    request.resolve([{ id: "newest-model", name: "" }]);
    await flush();
    assert.equal(f.select.disabled, false);
    assert.deepEqual(f.modelValues(), ["newest-model", "saved-model"]);
    assert.equal(f.select.value, "saved-model");
    assert.deepEqual(f.picked, []);
  } finally {
    f.dispose();
  }
});

test("incomplete settings wait until reset observes complete settings", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let complete = false;
  const f = fixture({
    canAutoLoad: () => complete,
    loadModels: async () => [{ id: "available-model", name: "" }],
  });
  try {
    t.mock.timers.tick(1000);
    assert.deepEqual(f.calls, []);
    complete = true;
    f.component.reset();
    t.mock.timers.tick(300);
    await flush();
    assert.deepEqual(f.calls, [undefined]);
    assert.deepEqual(f.modelValues(), ["", "available-model"]);
    assert.equal(f.select.value, "");
  } finally {
    f.dispose();
  }
});

test("reset restarts the edit debounce and dispose cancels pending automatic work", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({
    canAutoLoad: () => true,
    loadModels: async () => [{ id: "available-model", name: "" }],
  });
  try {
    t.mock.timers.tick(200);
    f.component.reset();
    t.mock.timers.tick(299);
    assert.deepEqual(f.calls, []);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(f.calls.length, 1);
    f.component.reset();
    f.component.dispose();
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(f.calls.length, 1);
  } finally {
    f.dispose();
  }
});

test("cached and synchronized catalogs need no automatic or focus requests", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const cached of [true, false]) {
    const catalog = [{ id: "available-model", name: "" }];
    const f = fixture({
      initialModels: cached ? catalog : undefined,
      canAutoLoad: () => true,
    });
    try {
      if (!cached) f.component.setModels(catalog);
      t.mock.timers.tick(1000);
      f.focusSelect();
      const event = f.mouseDown();
      assert.equal(event.defaultPrevented, false);
      assert.deepEqual(f.calls, []);
    } finally {
      f.dispose();
    }
  }
});

test("a first click loads before opening an empty menu and suppresses duplicate loading requests", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const request = deferred<DiscoveredModel[]>();
  const f = fixture({
    saved: "saved-model",
    canAutoLoad: () => true,
    loadModels: () => request.promise,
  });
  try {
    const firstClick = f.mouseDown();
    assert.equal(firstClick.defaultPrevented, true);
    assert.equal(f.select.disabled, true);
    f.focusSelect();
    t.mock.timers.tick(1000);
    assert.deepEqual(f.calls, [undefined]);
    request.resolve([{ id: "available-model", name: "" }]);
    await flush();
    assert.equal(f.select.disabled, false);
    assert.deepEqual(f.modelValues(), ["available-model", "saved-model"]);
    const nextClick = f.mouseDown();
    assert.equal(nextClick.defaultPrevented, false);
    assert.equal(f.calls.length, 1);
  } finally {
    f.dispose();
  }
});

test("explicit refresh cancels the queued automatic load and keeps a ready menu usable", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const request = deferred<DiscoveredModel[]>();
  const f = fixture({
    saved: "saved-model",
    canAutoLoad: () => true,
    loadModels: () => request.promise,
  });
  try {
    f.refresh.click();
    t.mock.timers.tick(1000);
    assert.deepEqual(f.calls, [{ force: true }]);
    request.resolve([{ id: "available-model", name: "" }]);
    await flush();
    f.refresh.click();
    assert.equal(f.select.disabled, false);
    assert.deepEqual(f.modelValues(), ["available-model", "saved-model"]);
    assert.deepEqual(f.calls, [{ force: true }, { force: true }]);
    await flush();
  } finally {
    f.dispose();
  }
});

test("a failed first load leaves custom entry available without implicit retries", async () => {
  const f = fixture({
    saved: "saved-model",
    loadModels: () => Promise.reject(new Error("API key required")),
  });
  try {
    assert.equal(f.mouseDown().defaultPrevented, true);
    await flush();
    assert.equal(f.select.disabled, false);
    assert.match(f.status.textContent!, /API key required/);
    assert.equal(f.mouseDown().defaultPrevented, false);
    f.focusSelect();
    assert.equal(f.calls.length, 1);
    f.customize();
    await flush();
    assert.equal(f.input.hidden, false);
    assert.equal(f.input.value, "saved-model");
    assert.deepEqual(f.picked, []);
  } finally {
    f.dispose();
  }
});

test("the native select is the initial control and loading is triggered by focus or explicit refresh", async () => {
  const f = fixture({
    saved: "saved-custom",
    loadModels: async () => [{ id: "catalog-model", name: "Catalog" }],
  });
  try {
    assert.equal(f.select.hidden, false);
    assert.equal(f.input.hidden, true);
    assert.equal(f.input.getAttribute("aria-label"), "original-model-id");
    assert.equal(
      f.select.getAttribute("aria-label"),
      "pref-provider-model-select",
    );
    assert.equal(f.refresh.textContent, "pref-provider-models-refresh");
    assert.equal(f.calls.length, 0);
    f.focusSelect();
    assert.equal(f.status.textContent, "pref-provider-models-fetching");
    await flush();
    assert.deepEqual(f.modelValues(), ["catalog-model", "saved-custom"]);
    assert.equal(f.select.value, "saved-custom");
    assert.deepEqual(f.picked, []);
    f.refresh.click();
    await flush();
    assert.deepEqual(f.calls, [undefined, { force: true }]);
  } finally {
    f.dispose();
  }
});

test("an empty model keeps a disabled placeholder without selecting the first discovered model", async () => {
  const f = fixture({
    loadModels: async () => [{ id: "first-model", name: "" }],
  });
  try {
    f.focusSelect();
    await flush();
    assert.deepEqual(f.modelValues(), ["", "first-model"]);
    assert.equal(f.select.value, "");
    assert.equal(f.select.options[0].disabled, true);
    assert.equal(f.select.options[0].textContent, "pref-provider-model-select");
    assert.equal(f.input.value, "");
    assert.deepEqual(f.picked, []);
    assert.equal(f.input.hidden, true);
  } finally {
    f.dispose();
  }
});

test("catalog order and unknown model IDs survive the display filter and Show all", () => {
  const f = fixture({
    saved: "tts-1",
    initialModels: [
      { id: "z-chat", name: "" },
      { id: "unknown-image-chat", name: "" },
      { id: "tts-1", name: "" },
      { id: "a-chat", name: "" },
    ],
  });
  try {
    assert.deepEqual(f.modelValues(), [
      "z-chat",
      "unknown-image-chat",
      "a-chat",
      "tts-1",
    ]);
    assert.equal(f.select.value, "tts-1");
    assert.equal(f.status.textContent, "pref-provider-models-hidden:1");
    f.showAll.click();
    assert.deepEqual(f.modelValues(), [
      "z-chat",
      "unknown-image-chat",
      "tts-1",
      "a-chat",
    ]);
    assert.equal(f.status.textContent, "pref-provider-models-total:4");
    f.showAll.click();
    assert.equal(f.select.value, "tts-1");
    assert.equal(f.input.value, "tts-1");
    assert.deepEqual(f.picked, []);
  } finally {
    f.dispose();
  }
});

test("catalog labels are plain text", () => {
  const f = fixture({
    initialModels: [{ id: "<b>model</b>", name: "<script>name</script>" }],
  });
  try {
    assert.equal(f.select.querySelector("b, script"), null);
    assert.equal(f.select.options[1].textContent, "<b>model</b>");
  } finally {
    f.dispose();
  }
});

test("only an explicit custom choice reveals the original input after change dispatch", async () => {
  const f = fixture({ saved: "saved-model" });
  try {
    assert.equal(
      f.select.options[f.select.options.length - 1].textContent,
      "pref-provider-model-custom",
    );
    f.customize();
    assert.equal(f.select.hidden, false);
    assert.equal(f.input.hidden, true);
    await flush();
    assert.equal(f.select.hidden, true);
    assert.equal(f.input.hidden, false);
    assert.equal(f.doc.activeElement, f.input);
    assert.equal(f.input.value, "saved-model");
    assert.deepEqual(f.picked, []);
    f.input.value = "typed-model";
    f.input.blur();
    assert.equal(f.select.hidden, false);
    assert.equal(f.input.hidden, true);
    assert.equal(f.select.value, "typed-model");
    assert.deepEqual(f.picked, []);
  } finally {
    f.dispose();
  }
});

test("a picked model updates the input and callback only after the change dispatch", async () => {
  const f = fixture({
    saved: "saved-model",
    initialModels: [{ id: "new-model", name: "" }],
  });
  try {
    f.change("new-model");
    assert.equal(f.input.value, "saved-model");
    assert.deepEqual(f.picked, []);
    await flush();
    assert.equal(f.input.value, "new-model");
    assert.equal(f.select.value, "new-model");
    assert.deepEqual(f.picked, ["new-model"]);
  } finally {
    f.dispose();
  }
});

test("a failed request stays visible without replacing the select or inventing candidates", async () => {
  const f = fixture({
    saved: "saved-model",
    loadModels: async () => {
      throw new Error("Codex login expired (HTTP 401)");
    },
  });
  try {
    f.focusSelect();
    await flush();
    assert.equal(
      f.status.textContent,
      "pref-provider-models-fetch-failed: Codex login expired (HTTP 401)",
    );
    assert.equal((f.status as HTMLElement).dataset.error, "true");
    assert.deepEqual(f.modelValues(), ["saved-model"]);
    assert.equal(f.input.hidden, true);
    assert.equal(f.select.hidden, false);
    assert.equal(f.select.value, "saved-model");
    assert.equal(f.refresh.disabled, false);
    assert.deepEqual(f.picked, []);
  } finally {
    f.dispose();
  }
});

test("non-Error rejections retain their detail as plain text", async () => {
  const f = fixture({
    saved: "saved-model",
    loadModels: () => Promise.reject("HTTP 403 <b>permission denied</b>"),
  });
  try {
    f.focusSelect();
    await flush();
    assert.equal(
      f.status.textContent,
      "pref-provider-models-fetch-failed: HTTP 403 <b>permission denied</b>",
    );
    assert.equal(f.status.querySelector("b"), null);
    assert.equal(f.select.value, "saved-model");
    assert.equal(f.input.hidden, true);
  } finally {
    f.dispose();
  }
});

test("reset, shared catalogs and retry clear previous failure details", async () => {
  for (const recovery of ["reset", "catalog", "retry"]) {
    const retry = deferred<DiscoveredModel[]>();
    let requests = 0;
    const f = fixture({
      saved: "saved-model",
      loadModels: () =>
        requests++ === 0
          ? Promise.reject(new Error("HTTP 401: log in again"))
          : retry.promise,
    });
    try {
      f.focusSelect();
      await flush();
      assert.match(f.status.textContent!, /HTTP 401: log in again/);
      if (recovery === "reset") f.component.reset();
      else if (recovery === "catalog")
        f.component.setModels([{ id: "available-model", name: "" }]);
      else {
        f.refresh.click();
        assert.equal(f.status.textContent, "pref-provider-models-fetching");
        retry.resolve([{ id: "available-model", name: "" }]);
        await flush();
      }
      assert.doesNotMatch(f.status.textContent!, /HTTP 401|log in again/);
      assert.equal((f.status as HTMLElement).dataset.error, undefined);
      assert.equal(f.select.value, "saved-model");
      assert.equal(f.input.hidden, true);
      assert.deepEqual(f.picked, []);
    } finally {
      f.dispose();
    }
  }
});

test("an arriving catalog waits until the native popup closes before rewriting options", async () => {
  for (const opening of ["mouse", "keyboard"]) {
    const request = deferred<DiscoveredModel[]>();
    const f = fixture({
      saved: "saved-model",
      initialModels: [{ id: "old-model", name: "" }],
      loadModels: () => request.promise,
    });
    try {
      f.refresh.click();
      if (opening === "mouse") f.mouseDown();
      else {
        f.focusSelect();
        f.select.dispatchEvent(
          new f.dom.window.KeyboardEvent("keydown", { key: "ArrowDown" }),
        );
      }
      const firstOption = f.select.options[0];
      request.resolve([{ id: "new-model", name: "" }]);
      await flush();
      assert.deepEqual(f.modelValues(), ["old-model", "saved-model"]);
      assert.equal(f.select.options[0], firstOption);
      f.blurSelect();
      assert.deepEqual(f.modelValues(), ["new-model", "saved-model"]);
      assert.equal(f.input.value, "saved-model");
      assert.deepEqual(f.picked, []);
    } finally {
      f.dispose();
    }
  }
});

test("a pending catalog rebuild also waits past a select change dispatch", async () => {
  const request = deferred<DiscoveredModel[]>();
  const f = fixture({
    saved: "saved-model",
    initialModels: [{ id: "chosen-model", name: "" }],
    loadModels: () => request.promise,
  });
  try {
    f.refresh.click();
    f.mouseDown();
    request.resolve([
      { id: "chosen-model", name: "" },
      { id: "new-model", name: "" },
    ]);
    await flush();
    const chosenOption = f.select.options[0];
    f.change("chosen-model");
    assert.equal(f.select.options[0], chosenOption);
    assert.deepEqual(f.modelValues(), ["chosen-model", "saved-model"]);
    assert.equal(f.input.value, "saved-model");
    await flush();
    assert.deepEqual(f.modelValues(), ["chosen-model", "new-model"]);
    assert.equal(f.input.value, "chosen-model");
    assert.deepEqual(f.picked, ["chosen-model"]);
  } finally {
    f.dispose();
  }
});

test("a late catalog never steals focus from explicit manual entry", async () => {
  const request = deferred<DiscoveredModel[]>();
  const f = fixture({
    saved: "saved-model",
    initialModels: [{ id: "old-model", name: "" }],
    loadModels: () => request.promise,
  });
  try {
    f.refresh.click();
    f.mouseDown();
    f.customize();
    await flush();
    f.input.value = "typed-model";
    request.resolve([{ id: "new-model", name: "" }]);
    await flush();
    assert.equal(f.input.hidden, false);
    assert.equal(f.select.hidden, true);
    assert.equal(f.doc.activeElement, f.input);
    assert.equal(f.input.value, "typed-model");
    f.input.blur();
    assert.equal(f.select.value, "typed-model");
    assert.deepEqual(f.modelValues(), ["new-model", "typed-model"]);
  } finally {
    f.dispose();
  }
});

test("shared catalog synchronization preserves current values without fetching or picking", () => {
  const f = fixture({ saved: "saved-custom" });
  try {
    f.component.setModels([
      { id: "second-model", name: "" },
      { id: "first-model", name: "" },
    ]);
    assert.deepEqual(f.modelValues(), [
      "second-model",
      "first-model",
      "saved-custom",
    ]);
    assert.equal(f.select.value, "saved-custom");
    assert.equal(f.input.value, "saved-custom");
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.picked, []);
    const savedOption = f.select.options[2];
    f.component.setModels([
      { id: "second-model", name: "Updated display name" },
      { id: "first-model", name: "" },
    ]);
    assert.equal(f.select.options[2], savedOption);
  } finally {
    f.dispose();
  }
});

test("shared catalogs use the popup gate and leave manual entry focused", async () => {
  const request = deferred<DiscoveredModel[]>();
  const f = fixture({
    saved: "saved-model",
    initialModels: [{ id: "old-model", name: "" }],
    loadModels: () => request.promise,
  });
  try {
    f.refresh.click();
    f.mouseDown();
    f.component.setModels([{ id: "shared-model", name: "" }]);
    assert.deepEqual(f.modelValues(), ["old-model", "saved-model"]);
    f.blurSelect();
    assert.deepEqual(f.modelValues(), ["shared-model", "saved-model"]);
    f.customize();
    await flush();
    f.input.value = "typed-model";
    f.component.setModels([{ id: "new-shared-model", name: "" }]);
    assert.equal(f.input.hidden, false);
    assert.equal(f.select.hidden, true);
    assert.equal(f.doc.activeElement, f.input);
    assert.equal(f.input.value, "typed-model");
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.picked, []);
  } finally {
    f.dispose();
  }
});

test("reset clears catalog state and excludes both stale responses and queued choices", async () => {
  const oldRequest = deferred<DiscoveredModel[]>();
  const newRequest = deferred<DiscoveredModel[]>();
  let requestIndex = 0;
  const f = fixture({
    saved: "saved-model",
    initialModels: [{ id: "old-choice", name: "" }],
    loadModels: () =>
      requestIndex++ === 0 ? oldRequest.promise : newRequest.promise,
  });
  try {
    f.refresh.click();
    f.change("old-choice");
    f.component.reset();
    assert.deepEqual(f.modelValues(), ["saved-model"]);
    assert.equal(f.status.textContent, "");
    oldRequest.resolve([{ id: "old-response", name: "" }]);
    await flush();
    assert.deepEqual(f.modelValues(), ["saved-model"]);
    assert.equal(f.input.value, "saved-model");
    assert.deepEqual(f.picked, []);
    f.refresh.click();
    newRequest.resolve([{ id: "new-response", name: "" }]);
    await flush();
    assert.deepEqual(f.modelValues(), ["new-response", "saved-model"]);
  } finally {
    f.dispose();
  }
});

test("dispose removes interaction handlers and prevents late request or choice updates", async () => {
  const request = deferred<DiscoveredModel[]>();
  const f = fixture({
    saved: "saved-model",
    initialModels: [{ id: "new-choice", name: "" }],
    loadModels: () => request.promise,
  });
  try {
    f.refresh.click();
    f.change("new-choice");
    f.component.dispose();
    const before =
      f.component.container.outerHTML + f.component.details.outerHTML;
    request.reject(new Error("late failure"));
    await flush();
    f.focusSelect();
    f.mouseDown();
    f.refresh.click();
    assert.equal(f.calls.length, 1);
    assert.equal(f.input.value, "saved-model");
    assert.deepEqual(f.picked, []);
    assert.equal(
      f.component.container.outerHTML + f.component.details.outerHTML,
      before,
    );
  } finally {
    f.dispose();
  }
});
