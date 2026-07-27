import assert from "node:assert/strict";
import test from "node:test";
import {
  saveProviderConfiguration,
  selectActiveModel,
  type ModelSelectionDependencies,
} from "../src/models/selection";
import type {
  ModelProviderConfiguration,
  RuntimeModel,
} from "../src/models/providers";

function configuration(
  activeModelId = "model-codex",
): ModelProviderConfiguration {
  return {
    schemaVersion: 2,
    activeModelId,
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
        id: "provider-api",
        name: "API",
        authMode: "openai_compatible",
        apiBase: "https://api.example.com/v1",
        apiKey: "secret",
        models: [
          {
            id: "model-api",
            model: "example-model",
            effort: "",
          },
        ],
      },
    ],
  };
}

function dependencies(current: ModelProviderConfiguration): {
  value: ModelSelectionDependencies;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    value: {
      getConfiguration: () => current,
      cancelModelTasks() {
        calls.push("cancel");
      },
      setActiveModelId(modelId) {
        calls.push(`set-active:${modelId}`);
        return {
          ...current.providers[1].models[0],
          providerId: "provider-api",
          providerName: "API",
          authMode: "openai_compatible",
          apiBase: "https://api.example.com/v1",
          apiKey: "secret",
          label: "API / example-model",
          active: true,
        } satisfies RuntimeModel;
      },
      setConfiguration(providers, activeModelId) {
        calls.push(`save:${activeModelId}`);
        return {
          schemaVersion: 2,
          providers,
          activeModelId,
        };
      },
    },
  };
}

test("validates a model selection before cancelling active tasks", () => {
  const harness = dependencies(configuration());

  assert.throws(
    () => selectActiveModel("missing-model", harness.value),
    /当前模型不存在/u,
  );
  assert.deepEqual(harness.calls, []);
});

test("cancels active tasks exactly once before switching models", () => {
  const harness = dependencies(configuration());

  selectActiveModel("model-api", harness.value);

  assert.deepEqual(harness.calls, ["cancel", "set-active:model-api"]);
});

test("saving a changed active model configuration cancels before persistence", () => {
  const current = configuration("model-api");
  const harness = dependencies(current);
  const changed = configuration("model-api");
  changed.providers[1].apiKey = "new-secret";

  saveProviderConfiguration(
    changed.providers,
    changed.activeModelId,
    harness.value,
  );

  assert.deepEqual(harness.calls, ["cancel", "save:model-api"]);
});
