import assert from "node:assert/strict";
import test from "node:test";
import {
  createProviderGroup,
  flattenRuntimeModels,
  getModelProviderConfiguration,
  migrateLegacyModelConfiguration,
  resolveDraftRuntimeModel,
  setActiveModelId,
  setModelProviderConfiguration,
  subscribeModelConfiguration,
  validateProviderGroup,
  type ModelProviderGroup,
} from "../src/models/providers";

test("migrates the existing Codex preferences into the active Codex provider", () => {
  const migrated = migrateLegacyModelConfiguration({
    model: "gpt-5.4",
    effort: "medium",
  });

  assert.equal(migrated.providers.length, 1);
  assert.deepEqual(migrated.providers[0], {
    id: "provider-codex",
    name: "服务商 A",
    authMode: "codex_auth",
    apiBase: "https://chatgpt.com/backend-api/codex/responses",
    apiKey: "",
    models: [
      {
        id: "model-codex-gpt-5-4",
        model: "gpt-5.4",
        effort: "medium",
      },
    ],
  });
  assert.equal(migrated.activeModelId, "model-codex-gpt-5-4");
  assert.equal(migrated.schemaVersion, 2);
});

test("flattens multiple providers while preserving one explicit active model", () => {
  const providers: ModelProviderGroup[] = [
    {
      id: "provider-codex",
      name: "Codex",
      authMode: "codex_auth",
      apiBase: "https://chatgpt.com/backend-api/codex/responses",
      apiKey: "",
      models: [{ id: "model-gpt", model: "gpt-5.4", effort: "medium" }],
    },
    {
      id: "provider-deepseek",
      name: "DeepSeek",
      authMode: "openai_compatible",
      apiBase: "https://api.deepseek.com/v1",
      apiKey: "secret",
      models: [
        { id: "model-deepseek", model: "deepseek-v4-flash", effort: "" },
      ],
    },
  ];

  assert.deepEqual(
    flattenRuntimeModels(providers, "model-deepseek").map((entry) => ({
      id: entry.id,
      label: entry.label,
      active: entry.active,
      authMode: entry.authMode,
    })),
    [
      {
        id: "model-gpt",
        label: "Codex / gpt-5.4",
        active: false,
        authMode: "codex_auth",
      },
      {
        id: "model-deepseek",
        label: "DeepSeek / deepseek-v4-flash",
        active: true,
        authMode: "openai_compatible",
      },
    ],
  );
});

test("rejects an incomplete OpenAI Compatible provider instead of saving defaults", () => {
  const provider = createProviderGroup("openai_compatible");
  provider.name = "DeepSeek";
  provider.models.push({
    id: "model-deepseek",
    model: "deepseek-chat",
    effort: "",
  });

  assert.throws(() => validateProviderGroup(provider), /API Base.*API Key/u);
});

test("rejects every blank model row instead of silently dropping it", () => {
  const provider = createProviderGroup("openai_compatible");
  provider.name = "DeepSeek";
  provider.apiBase = "https://api.deepseek.com/v1";
  provider.apiKey = "secret";
  provider.models.push(
    { id: "model-ready", model: "deepseek-chat", effort: "" },
    { id: "model-incomplete", model: " ", effort: "" },
  );

  assert.throws(() => validateProviderGroup(provider), /模型 ID/u);
});

test("tests one complete model without validating unfinished sibling rows", () => {
  const provider = createProviderGroup("openai_compatible");
  provider.name = "DeepSeek";
  provider.apiBase = "https://api.deepseek.com/v1";
  provider.apiKey = "secret";
  const ready = {
    id: "model-ready",
    model: "deepseek-chat",
    effort: "",
  };
  provider.models.push(ready, {
    id: "model-incomplete",
    model: "",
    effort: "",
  });

  assert.equal(
    resolveDraftRuntimeModel(provider, ready).model,
    "deepseek-chat",
  );
});

test("notifies both model-selection interfaces from the shared active model preference", () => {
  const preferences = new Map<string, unknown>();
  (globalThis as any).Zotero = {
    Prefs: {
      get(key: string) {
        return preferences.get(key);
      },
      set(key: string, value: unknown) {
        preferences.set(key, value);
      },
    },
  };
  const codex = migrateLegacyModelConfiguration({
    model: "gpt-5.4",
    effort: "medium",
  });
  const api = createProviderGroup("openai_compatible");
  api.name = "API";
  api.apiBase = "https://api.example.com/v1";
  api.apiKey = "secret";
  api.models = [
    {
      id: "model-api",
      model: "example-model",
      effort: "",
    },
  ];
  setModelProviderConfiguration([...codex.providers, api], codex.activeModelId);
  let notifications = 0;
  const unsubscribe = subscribeModelConfiguration(() => {
    notifications += 1;
  });

  setActiveModelId("model-api");
  assert.equal(notifications, 1);
  unsubscribe();
  setActiveModelId(codex.activeModelId);
  assert.equal(notifications, 1);
});

test("upgrades the first saved provider name without changing user providers", () => {
  const preferences = new Map<string, unknown>();
  const prefix = "extensions.zotero.PaperTranslateForZotero";
  preferences.set(
    `${prefix}.paper.modelProviders`,
    JSON.stringify({
      schemaVersion: 1,
      providers: [
        {
          id: "provider-codex",
          name: "Codex",
          authMode: "codex_auth",
          apiBase: "https://chatgpt.com/backend-api/codex/responses",
          apiKey: "",
          models: [
            {
              id: "model-codex",
              model: "gpt-5.4",
              effort: "medium",
            },
          ],
        },
        {
          id: "provider-custom",
          name: "我的服务商",
          authMode: "openai_compatible",
          apiBase: "https://api.example.com/v1",
          apiKey: "secret",
          models: [
            {
              id: "model-custom",
              model: "custom-model",
              effort: "",
            },
          ],
        },
      ],
    }),
  );
  preferences.set(`${prefix}.paper.activeModelId`, "model-codex");
  (globalThis as any).Zotero = {
    Prefs: {
      get(key: string) {
        return preferences.get(key);
      },
      set(key: string, value: unknown) {
        preferences.set(key, value);
      },
    },
  };

  const upgraded = getModelProviderConfiguration();

  assert.equal(upgraded.schemaVersion, 2);
  assert.deepEqual(
    upgraded.providers.map((provider) => provider.name),
    ["服务商 A", "我的服务商"],
  );
  assert.match(
    String(preferences.get(`${prefix}.paper.modelProviders`)),
    /"schemaVersion":2/u,
  );
});
