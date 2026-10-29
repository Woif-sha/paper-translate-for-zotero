import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { openModelPicker } from "../src/modules/modelPicker";
import type { DiscoveredModel } from "../src/models/modelDiscovery";

function fixture(models: DiscoveredModel[], existing = new Set<string>()) {
  const dom = new JSDOM(
    '<main class="pt-provider-preferences"><button id="trigger">Fetch</button></main>',
  );
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
  let confirmed: string[] | undefined;
  const close = openModelPicker({
    root: doc.querySelector("main")!,
    models,
    existing,
    trigger: doc.querySelector("button")!,
    onConfirm: (ids) => {
      confirmed = ids;
    },
    onClose() {},
  });
  const dialog = doc.querySelector("dialog")!;
  const toggle = dialog.querySelector(
    '[aria-label="pref-provider-models-show-all"]',
  ) as HTMLInputElement;
  const search = dialog.querySelector(
    'input[type="search"]',
  ) as HTMLInputElement;
  const checkbox = (id: string) =>
    Array.from(
      dialog.querySelectorAll<HTMLInputElement>(".pt-model-picker-row input"),
    ).find((node) => node.value === id)!;
  const visible = () =>
    Array.from(dialog.querySelectorAll<HTMLElement>(".pt-model-picker-row"))
      .filter((row) => !row.hidden)
      .map((row) => (row.querySelector("input") as HTMLInputElement).value);
  const filterStatus = () =>
    dialog.querySelector(".pt-model-picker-filter-status")!.textContent!;
  const empty = dialog.querySelector(
    ".pt-model-picker-list > p",
  ) as HTMLElement;
  const confirm = () =>
    (dialog.querySelector(".pt-save-button") as HTMLButtonElement).click();
  return {
    dom,
    doc,
    dialog,
    toggle,
    search,
    checkbox,
    visible,
    empty,
    confirm,
    filterStatus,
    get confirmed() {
      return confirmed;
    },
    searchFor(value: string) {
      search.value = value;
      search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    },
    dispose() {
      close();
      dom.window.close();
    },
  };
}

test("default filtering, Show all and search compose without losing unrelated selections", () => {
  const f = fixture(
    [
      { id: "gpt-6-luna", name: "" },
      { id: "unknown-image-chat", name: "Custom model" },
      { id: "tts-1", name: "Speech" },
      { id: "whisper-1", name: "Transcription" },
      { id: "custom-drawing", name: "", outputModalities: ["image"] },
    ],
    new Set(["whisper-1"]),
  );
  try {
    assert.equal(f.toggle.checked, false);
    assert.deepEqual(f.visible(), ["gpt-6-luna", "unknown-image-chat"]);
    assert.match(f.filterStatus(), /hidden:3$/);
    assert.equal(f.checkbox("whisper-1").disabled, true);
    assert.equal(f.checkbox("whisper-1").checked, true);
    f.searchFor("tts");
    assert.deepEqual(f.visible(), []);
    assert.equal(f.empty.hidden, false);
    assert.equal(f.empty.textContent, "pref-provider-models-no-match-filtered");
    f.toggle.click();
    assert.deepEqual(f.visible(), ["tts-1"]);
    assert.match(f.filterStatus(), /total:5$/);
    f.checkbox("tts-1").click();
    f.searchFor("Custom model");
    assert.deepEqual(f.visible(), ["unknown-image-chat"]);
    f.checkbox("unknown-image-chat").click();
    f.toggle.click();
    assert.match(f.filterStatus(), /hidden-cleared$/);
    assert.equal(
      f.checkbox("tts-1").checked,
      false,
      "turning off Show all deselects newly hidden specialist models",
    );
    assert.equal(
      f.checkbox("whisper-1").checked,
      true,
      "already-configured models remain intact",
    );
    assert.equal(f.checkbox("unknown-image-chat").checked, true);
    f.searchFor("gpt");
    f.confirm();
    assert.deepEqual(
      f.confirmed,
      ["unknown-image-chat"],
      "searching preserves selections on other search pages",
    );
    assert.equal(f.doc.querySelector("dialog"), null);
    assert.equal(f.doc.activeElement, f.doc.getElementById("trigger"));
  } finally {
    f.dispose();
  }
});

test("a catalog containing only specialist models offers Show all and still permits explicit selection", () => {
  const f = fixture([
    { id: "tts-1", name: "" },
    { id: "chatgpt-image-latest", name: "" },
  ]);
  try {
    assert.deepEqual(f.visible(), []);
    assert.equal(f.empty.hidden, false);
    assert.equal(
      (f.dialog.querySelector(".pt-save-button") as HTMLButtonElement).disabled,
      true,
    );
    f.toggle.click();
    assert.equal(f.visible().length, 2);
    f.checkbox("tts-1").click();
    f.confirm();
    assert.deepEqual(f.confirmed, ["tts-1"]);
  } finally {
    f.dispose();
  }
});
