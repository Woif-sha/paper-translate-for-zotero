import assert from "node:assert/strict";
import test from "node:test";
import {
  API_PROTOCOLS,
  PROVIDER_PRESETS,
  endpointPreview,
  normalizeApiSettings,
  resolveApiEndpoint,
} from "../src/models/protocols";
import { ApiStreamParser } from "../src/models/apiStreamParser";
import {
  buildApiHeaders,
  buildOpenAICompatiblePayload,
  runOpenAICompatibleRequest,
} from "../src/models/openAICompatibleClient";
import { withRequestDeadline } from "../src/models/requestLifetime";
import {
  getModelProviderConfiguration,
  setModelProviderConfiguration,
  type RuntimeModel,
} from "../src/models/providers";
import {
  modelCacheIdentity,
  runModelRequest,
  testModelConnection,
} from "../src/models/runtime";
import {
  CONNECTION_TEST_IMAGE,
  testModelImageConnection,
} from "../src/models/connectionTests";
import {
  DEFAULT_CODEX_API_URL,
  CodexResponsesStreamParser,
  runLegacyCodexRequest,
} from "../src/codex/legacyClient";

const request = {
  apiBase: "https://example.test/v1",
  apiKey: "fake-key",
  model: "example-model",
  instructions: "Translate.",
  prompt: "Source text",
};
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const chat = (text: string, reason = "stop") =>
  event({ choices: [{ delta: { content: text }, finish_reason: null }] }) +
  event({ choices: [{ delta: {}, finish_reason: reason }] }) +
  "data: [DONE]\n\n";
const responses = (text: string) =>
  event({ type: "response.output_text.delta", delta: text }) +
  event({ type: "response.completed", response: { status: "completed" } });
const anthropic = (text: string) =>
  event({ type: "message_start", message: {} }) +
  event({
    type: "content_block_start",
    content_block: { type: "text", text: "" },
  }) +
  event({ type: "content_block_delta", delta: { type: "text_delta", text } }) +
  event({ type: "message_delta", delta: { stop_reason: "end_turn" } }) +
  event({ type: "message_stop" });

function runtime(overrides: Partial<RuntimeModel> = {}): RuntimeModel {
  return {
    ...request,
    id: "model-one",
    providerId: "provider-one",
    providerName: "Example",
    authMode: "openai_compatible",
    effort: "",
    active: true,
    label: "Example",
    ...overrides,
  };
}

test("all seven explicit URL presets resolve unchanged with their selected protocol", () => {
  assert.equal(PROVIDER_PRESETS.length, 7);
  assert.equal(
    resolveApiEndpoint(
      "https://api.deepseek.com/anthropic",
      "anthropic_messages",
    ),
    "https://api.deepseek.com/anthropic/v1/messages",
  );
  for (const preset of PROVIDER_PRESETS)
    assert.equal(resolveApiEndpoint(preset.url, preset.protocol), preset.url);
  assert.equal(
    resolveApiEndpoint("https://example.test", "anthropic_messages"),
    "https://example.test/v1/messages",
  );
  assert.equal(
    resolveApiEndpoint(
      "https://example.test/proxy/v1/?api-version=2026-01-01",
      "responses",
    ),
    "https://example.test/proxy/v1/responses?api-version=2026-01-01",
  );
  assert.equal(
    endpointPreview("https://example.test/v1/responses?key=secret"),
    "https://example.test/v1/responses?…",
  );
});

test("a bare DONE marker cannot turn partial text into a successful response", () => {
  const chatParser = new ApiStreamParser("chat_completions");
  assert.throws(
    () =>
      chatParser.feed(
        event({ choices: [{ delta: { content: "partial" } }] }) +
          "data: [DONE]\n\n",
      ),
    /finish_reason/u,
  );
  const codexParser = new CodexResponsesStreamParser();
  assert.throws(
    () =>
      codexParser.feed(
        event({ type: "response.output_text.delta", delta: "partial" }) +
          "data: [DONE]\n\n",
      ),
    /response.completed/u,
  );
});

test("endpoint mismatch, insecure schemes and credentials fail before sending", async () => {
  for (const url of [
    "https://example.test/v1/responses",
    "http://example.test/v1",
    "https://user:password@example.test/v1",
    "https://example.test/v1#fragment",
  ]) {
    await assert.rejects(
      runOpenAICompatibleRequest({
        ...request,
        apiBase: url,
        fetchFn: async () => assert.fail("must not send"),
      }),
    );
  }
  for (const settings of [
    { protocol: "invalid" },
    { timeoutSeconds: 0 },
    { maxTokens: -1 },
    { workspaceId: "bad\r\nheader" },
    { anthropicVersion: "bad-version" },
  ]) {
    assert.throws(() => normalizeApiSettings(settings as any));
  }
});

test("Responses and Anthropic payloads convert text and images without Codex authentication", () => {
  const image = {
    dataUrl: "data:image/png;base64,iVBORw==",
    detail: "high" as const,
  };
  const publicPayload = buildOpenAICompatiblePayload({
    ...request,
    protocol: "responses",
    image,
  });
  assert.equal(publicPayload.instructions, request.instructions);
  assert.equal(publicPayload.messages, undefined);
  assert.deepEqual((publicPayload.input as any[])[0].content[1], {
    type: "input_image",
    image_url: image.dataUrl,
    detail: "high",
  });
  const nativePayload = buildOpenAICompatiblePayload({
    ...request,
    protocol: "anthropic_messages",
    image,
    maxTokens: 256,
  });
  assert.equal(nativePayload.system, request.instructions);
  assert.equal(nativePayload.max_tokens, 256);
  assert.deepEqual((nativePayload.messages as any[])[0].content[1], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "iVBORw==" },
  });
  assert.deepEqual(
    buildApiHeaders({
      apiKey: "test",
      protocol: "anthropic_messages",
      anthropicVersion: "2023-06-01",
      workspaceId: "wrkspc_test",
    }),
    {
      "Content-Type": "application/json",
      "x-api-key": "test",
      "anthropic-version": "2023-06-01",
      "anthropic-workspace-id": "wrkspc_test",
    },
  );
  assert.equal(
    buildApiHeaders({ apiKey: "test", protocol: "responses" }).Authorization,
    "Bearer test",
  );
});

test("each protocol completes at its terminal event without waiting for socket closure", async () => {
  for (const [protocol, body] of [
    ["chat_completions", chat("译文")],
    ["responses", responses("译文")],
    ["anthropic_messages", anthropic("译文")],
  ] as const) {
    let cancelled = false;
    const result = await runOpenAICompatibleRequest({
      ...request,
      protocol,
      fetchFn: async (url, init) => {
        assert.equal(url, resolveApiEndpoint(request.apiBase, protocol));
        assert.equal(init?.redirect, "error");
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(body));
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      },
    });
    assert.equal(result.text, "译文");
    assert.equal(cancelled, true);
  }
});

test("SSE framing survives every split including UTF-8 and CRLF boundaries", async () => {
  for (const [protocol, body] of [
    ["responses", responses("译文")],
    ["anthropic_messages", anthropic("译文")],
  ] as const) {
    const bytes = new TextEncoder().encode(body.replace(/\n/gu, "\r\n"));
    const result = await runOpenAICompatibleRequest({
      ...request,
      protocol,
      fetchFn: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
              controller.close();
            },
          }),
        ),
    });
    assert.equal(result.text, "译文");
  }
});

test("truncation, filters, refusal, missing terminal events and invalid JSON are never success", () => {
  const failures = [
    ["chat_completions", chat("partial", "length")],
    ["chat_completions", chat("partial", "content_filter")],
    [
      "responses",
      event({
        type: "response.incomplete",
        response: { incomplete_details: { reason: "max_output_tokens" } },
      }),
    ],
    [
      "responses",
      event({
        type: "response.failed",
        response: { error: { message: "failed" } },
      }),
    ],
    ["responses", event({ type: "response.refusal.delta", delta: "refused" })],
    [
      "responses",
      event({ type: "response.output_text.delta", delta: "partial" }),
    ],
    [
      "anthropic_messages",
      event({ type: "message_delta", delta: { stop_reason: "max_tokens" } }),
    ],
    ["anthropic_messages", event({ type: "message_stop" })],
    ["anthropic_messages", "data: {invalid}\n\n"],
  ] as const;
  for (const [protocol, body] of failures) {
    const parser = new ApiStreamParser(protocol);
    assert.throws(() => {
      parser.feed(body);
      parser.finish();
    });
  }
});

test("errors for every protocol redact keys and enforce response limits", async () => {
  for (const [protocol] of API_PROTOCOLS) {
    await assert.rejects(
      runOpenAICompatibleRequest({
        ...request,
        protocol,
        fetchFn: async () =>
          new Response(event({ error: { message: "invalid fake-key" } })),
      }),
      (error: unknown) => {
        assert.doesNotMatch(String(error), /fake-key/u);
        assert.match(String(error), /REDACTED/u);
        return true;
      },
    );
    const body =
      protocol === "responses"
        ? responses("too long")
        : protocol === "anthropic_messages"
          ? anthropic("too long")
          : chat("too long");
    await assert.rejects(
      runOpenAICompatibleRequest({
        ...request,
        protocol,
        maxOutputCharacters: 2,
        fetchFn: async () => new Response(body),
      }),
      /character limit/u,
    );
    await assert.rejects(
      runOpenAICompatibleRequest({
        ...request,
        protocol,
        maxResponseBytes: 2,
        fetchFn: async () => new Response(body),
      }),
      /byte limit/u,
    );
  }
});

test("deadline rejects and aborts a hung transport; parent cancellation sends no request", async () => {
  let aborted = false;
  await assert.rejects(
    withRequestDeadline(async (signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise(() => undefined);
    }, 10),
    /timed out/u,
  );
  assert.equal(aborted, true);
  const parent = new AbortController();
  parent.abort(new Error("user cancelled"));
  await assert.rejects(
    withRequestDeadline(
      async () => assert.fail("no dispatch"),
      1000,
      parent.signal,
    ),
    /user cancelled/u,
  );
  const model = runtime();
  await assert.rejects(
    runModelRequest(
      { instructions: "test", prompt: "test", signal: parent.signal },
      model,
      {
        codex: async () => assert.fail(),
        openAICompatible: async () => assert.fail(),
      },
    ),
    /user cancelled/u,
  );
});

test("schema-2 migration preserves key, endpoint, model selection and Chat Completions", () => {
  const prefs = new Map<string, unknown>();
  const prefix = "extensions.zotero.PaperTranslateForZotero.";
  const provider = {
    id: "p",
    name: "Custom",
    authMode: "openai_compatible",
    apiBase: "https://example.test/v1",
    apiKey: "fake-preserved-key",
    models: [{ id: "m", model: "my-model", effort: "" }],
  };
  prefs.set(
    prefix + "paper.modelProviders",
    JSON.stringify({ schemaVersion: 2, providers: [provider] }),
  );
  prefs.set(prefix + "paper.activeModelId", "m");
  (globalThis as any).Zotero = {
    Prefs: {
      get: (key: string) => prefs.get(key),
      set: (key: string, value: unknown) => prefs.set(key, value),
    },
  };
  const migrated = getModelProviderConfiguration();
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.activeModelId, "m");
  assert.equal(migrated.providers[0].apiKey, provider.apiKey);
  assert.equal(migrated.providers[0].apiBase, provider.apiBase);
  assert.equal(migrated.providers[0].protocol, "chat_completions");
  assert.equal(migrated.providers[0].presetId, "custom");
  assert.equal(migrated.providers[0].models[0].model, "my-model");
  assert.throws(
    () =>
      setModelProviderConfiguration(
        [
          {
            ...migrated.providers[0],
            apiBase: "https://example.test/v1/responses",
          },
        ],
        "m",
      ),
    /不匹配/u,
  );
  assert.equal(
    getModelProviderConfiguration().providers[0].apiBase,
    provider.apiBase,
  );
});

test("a cancelled request cannot publish late text even if its transport ignores abort", async () => {
  const parent = new AbortController();
  let transportRequest: any;
  let resolveTransport: (value: any) => void = () => undefined;
  let updates = 0;
  const task = runModelRequest(
    {
      instructions: "Translate",
      prompt: "Text",
      signal: parent.signal,
      onDelta: () => {
        updates += 1;
      },
    },
    runtime(),
    {
      codex: async () => assert.fail("must not use Codex"),
      openAICompatible: async (params) => {
        transportRequest = params;
        return new Promise((resolve) => {
          resolveTransport = resolve;
        });
      },
    },
  );
  await Promise.resolve();
  parent.abort(new Error("cancel this task"));
  await assert.rejects(task, /cancel this task/u);
  transportRequest.onDelta("late", "late text");
  assert.equal(updates, 0);
  resolveTransport({
    text: "late text",
    usedWebSearch: false,
    webSearchCalls: 0,
    citedUrls: [],
  });
});

test("protocol and workspace are part of OCR cache identity", () => {
  assert.notEqual(
    modelCacheIdentity(runtime()),
    modelCacheIdentity(runtime({ protocol: "responses" })),
  );
  assert.notEqual(
    modelCacheIdentity(runtime()),
    modelCacheIdentity(runtime({ workspaceId: "workspace" })),
  );
});

test("text and image tests use the selected protocol, validate OCR JSON and never read a paper", async () => {
  assert.match(CONNECTION_TEST_IMAGE, /^data:image\/png;base64,/u);
  let captured: any;
  (globalThis as any).ztoolkit = {
    getGlobal: () => async (_url: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body));
      const prompt = JSON.stringify(captured);
      const text = prompt.includes("input_image") ? '{"text":"TEST 42"}' : "OK";
      return new Response(responses(text));
    },
  };
  assert.equal(
    await testModelConnection(runtime({ protocol: "responses" })),
    "OK",
  );
  assert.equal(
    await testModelImageConnection(runtime({ protocol: "responses" })),
    "TEST 42",
  );
  assert.equal(captured.input[0].content[1].image_url, CONNECTION_TEST_IMAGE);
  (globalThis as any).ztoolkit = {
    getGlobal: () => async () =>
      new Response(responses("unstructured OCR text")),
  };
  await assert.rejects(
    testModelImageConnection(runtime({ protocol: "responses" })),
    /not valid JSON/u,
  );
});

test("Codex also resolves at response.completed while the connection remains open", async () => {
  const previous = {
    Services: (globalThis as any).Services,
    IOUtils: (globalThis as any).IOUtils,
    ztoolkit: (globalThis as any).ztoolkit,
  };
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  (globalThis as any).Services = { env: { get: () => "C:\\FakeTestAuth" } };
  (globalThis as any).IOUtils = {
    read: async () =>
      new TextEncoder().encode(
        JSON.stringify({
          tokens: {
            access_token: "fake-access",
            refresh_token: "fake-refresh",
          },
        }),
      ),
    write: async () => assert.fail("No auth write expected"),
  };
  (globalThis as any).ztoolkit = {
    getGlobal: () => async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(new TextEncoder().encode(responses("OK")));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  };
  try {
    const result = await withRequestDeadline(
      (signal) =>
        runLegacyCodexRequest({
          apiUrl: DEFAULT_CODEX_API_URL,
          model: "test-model",
          instructions: "Reply OK",
          prompt: "Test",
          signal,
        }),
      1000,
    );
    assert.equal(result.text, "OK");
    assert.equal(cancelled, true);
  } finally {
    if (!cancelled) streamController?.close();
    Object.assign(globalThis, previous);
  }
});
