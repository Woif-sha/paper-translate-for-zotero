import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderEditorDraft,
  PROVIDER_EDITOR_DRAFT_PREF,
} from "../src/models/providerEditorDraft";
import {
  validateProviderGroup,
  type ModelProviderGroup,
} from "../src/models/providers";
import { config } from "../package.json";

function setup() {
  const prefs = new Map<string, unknown>();
  (globalThis as any).Zotero = {
    Prefs: {
      get: (key: string) => prefs.get(key),
      set: (key: string, value: unknown) => prefs.set(key, value),
    },
  };
  const saved: ModelProviderGroup[] = [
    {
      id: "p",
      name: "Saved",
      authMode: "openai_compatible",
      protocol: "responses",
      presetId: "openai-responses",
      apiBase: "https://api.openai.com/v1/responses",
      apiKey: "fake-saved-key",
      timeoutSeconds: 120,
      models: [{ id: "m", model: "example-model", effort: "" }],
    },
  ];
  const read = () =>
    String(
      prefs.get(`${config.prefsPrefix}.${PROVIDER_EDITOR_DRAFT_PREF}`) || "",
    );
  return { prefs, saved, read };
}

test("switching authentication remembers connection settings and Codex effort without mixing credentials", () => {
  const { saved } = setup();
  const memory = new ProviderEditorDraft(saved, "");
  const p = memory.providers[0];
  p.timeoutSeconds = 90;
  memory.switchAuth(p, "codex_auth");
  assert.equal(p.apiKey, "");
  assert.match(p.apiBase, /chatgpt.com/);
  p.models[0].effort = "xhigh";
  memory.switchAuth(p, "openai_compatible");
  assert.equal(p.apiKey, "fake-saved-key");
  assert.equal(p.protocol, "responses");
  assert.equal(p.apiBase, "https://api.openai.com/v1/responses");
  assert.equal(p.timeoutSeconds, 90);
  assert.equal(p.models[0].id, "m");
  assert.equal(p.models[0].model, "example-model");
  memory.switchAuth(p, "codex_auth");
  assert.equal(p.models[0].effort, "xhigh");
  assert.equal(saved[0].apiKey, "fake-saved-key");
  assert.equal(saved[0].timeoutSeconds, 120);
});

test("preset memory restores each host's own key, retaining custom endpoints and rejecting key reuse on first host switch", () => {
  const { saved } = setup();
  const memory = new ProviderEditorDraft(saved, "");
  const p = memory.providers[0];
  memory.switchPreset(p, "deepseek-chat");
  assert.equal(p.apiKey, "");
  p.apiKey = "fake-deepseek-key";
  memory.switchPreset(p, "openai-responses");
  assert.equal(p.apiKey, "fake-saved-key");
  memory.switchPreset(p, "deepseek-chat");
  assert.equal(p.apiKey, "fake-deepseek-key");
  memory.switchPreset(p, "custom");
  p.apiBase = "https://proxy.test/v1";
  p.apiKey = "fake-proxy-key";
  p.protocol = "responses";
  memory.switchPreset(p, "openai-responses");
  memory.switchPreset(p, "custom");
  assert.equal(p.apiBase, "https://proxy.test/v1");
  assert.equal(p.apiKey, "fake-proxy-key");
  assert.equal(p.protocol, "responses");
});

test("partial drafts, inactive API fields and UI state survive reload using only a separate Zotero preference", () => {
  const { prefs, saved, read } = setup();
  const memory = new ProviderEditorDraft(saved, "");
  const p = memory.providers[0];
  p.name = "Unfinished";
  p.apiBase = "unfinished address";
  p.timeoutSeconds = 0;
  p.apiKey = "fake-draft-key";
  memory.openProviderIds.add("p");
  memory.openModelIds.add("m");
  memory.tab = 1;
  memory.switchAuth(p, "codex_auth");
  memory.remember();
  const restored = new ProviderEditorDraft(saved, read());
  assert.equal(restored.invalidCache, false);
  assert.equal(restored.tab, 1);
  assert.equal(restored.openProviderIds.has("p"), true);
  assert.equal(restored.openModelIds.has("m"), true);
  assert.equal(restored.providers[0].name, "Unfinished");
  restored.switchAuth(restored.providers[0], "openai_compatible");
  assert.equal(restored.providers[0].apiBase, "unfinished address");
  assert.equal(restored.providers[0].apiKey, "fake-draft-key");
  assert.equal(restored.providers[0].timeoutSeconds, 0);
  assert.deepEqual(
    [...prefs.keys()],
    [`${config.prefsPrefix}.${PROVIDER_EDITOR_DRAFT_PREF}`],
  );
  assert.equal(saved[0].name, "Saved");
});

test("saving Codex settings retains inactive API memory across the next editor instance", () => {
  const { saved, read } = setup();
  const memory = new ProviderEditorDraft(saved, "");
  memory.switchAuth(memory.providers[0], "codex_auth");
  const committed = memory.providers.map(validateProviderGroup);
  memory.acceptSaved(committed);
  memory.remember();
  const restored = new ProviderEditorDraft(committed, read());
  restored.switchAuth(restored.providers[0], "openai_compatible");
  assert.equal(restored.providers[0].apiKey, "fake-saved-key");
});

test("externally changed saved configuration takes precedence and corrupt drafts never expose credential fragments", () => {
  const { saved, read } = setup();
  const memory = new ProviderEditorDraft(saved, "");
  memory.providers[0].apiKey = "old-draft-key";
  memory.remember();
  const changed = structuredClone(saved);
  changed[0].apiKey = "new-saved-key";
  assert.equal(
    new ProviderEditorDraft(changed, read()).providers[0].apiKey,
    "new-saved-key",
  );
  const invalid = new ProviderEditorDraft(saved, '{"apiKey":"fake-secret"');
  assert.equal(invalid.invalidCache, true);
  assert.equal(invalid.providers[0].apiKey, "fake-saved-key");
});
