import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runModelRequest } from "../src/models/runtime";
import type { RuntimeModel } from "../src/models/providers";

const baseRequest = {
  instructions: "Translate faithfully.",
  prompt: "Source",
};

test("routes one request only to the explicitly selected Codex model", async () => {
  const calls: string[] = [];
  const model: RuntimeModel = {
    id: "model-gpt",
    model: "gpt-5.4",
    effort: "medium",
    providerId: "provider-codex",
    providerName: "Codex",
    authMode: "codex_auth",
    apiBase: "https://chatgpt.com/backend-api/codex/responses",
    apiKey: "",
    label: "Codex / gpt-5.4",
    active: true,
  };

  const result = await runModelRequest(baseRequest, model, {
    async codex() {
      calls.push("codex");
      return {
        text: "译文",
        usedWebSearch: false,
        webSearchCalls: 0,
        citedUrls: [],
      };
    },
    async openAICompatible() {
      calls.push("api");
      throw new Error("must not use API");
    },
  });

  assert.equal(result.text, "译文");
  assert.deepEqual(calls, ["codex"]);
});

test("does not fall back to Codex after an OpenAI Compatible failure", async () => {
  const calls: string[] = [];
  const model: RuntimeModel = {
    id: "model-deepseek",
    model: "deepseek-v4-flash",
    effort: "",
    providerId: "provider-deepseek",
    providerName: "DeepSeek",
    authMode: "openai_compatible",
    apiBase: "https://api.deepseek.com/v1",
    apiKey: "secret",
    label: "DeepSeek / deepseek-v4-flash",
    active: true,
  };

  await assert.rejects(
    runModelRequest(baseRequest, model, {
      async codex() {
        calls.push("codex");
        throw new Error("must not use Codex");
      },
      async openAICompatible() {
        calls.push("api");
        throw new Error("provider rejected request");
      },
    }),
    /provider rejected request/u,
  );
  assert.deepEqual(calls, ["api"]);
});

test("all model task entry points use the shared runtime instead of Codex directly", async () => {
  for (const path of [
    "../src/backends/translator.ts",
    "../src/context/research.ts",
    "../src/ocr/modelOcr.ts",
  ]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /runModelRequest/u);
    assert.doesNotMatch(source, /runLegacyCodexRequest/u);
  }
});
