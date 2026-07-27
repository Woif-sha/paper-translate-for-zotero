import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenAICompatibleStreamParser,
  buildOpenAICompatiblePayload,
  resolveChatCompletionsEndpoint,
  runOpenAICompatibleRequest,
} from "../src/models/openAICompatibleClient";

test("builds the minimum Chat Completions payload without optional model parameters", () => {
  assert.deepEqual(
    buildOpenAICompatiblePayload({
      model: "deepseek-v4-flash",
      instructions: "Translate faithfully.",
      prompt: "Source text",
    }),
    {
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: "Translate faithfully." },
        { role: "user", content: "Source text" },
      ],
      stream: true,
    },
  );
});

test("uses a full Chat Completions endpoint or appends it to an API base", () => {
  assert.equal(
    resolveChatCompletionsEndpoint("https://api.deepseek.com/v1"),
    "https://api.deepseek.com/v1/chat/completions",
  );
  assert.equal(
    resolveChatCompletionsEndpoint(
      "https://example.test/openai/chat/completions",
    ),
    "https://example.test/openai/chat/completions",
  );
});

test("parses streamed text and requires the explicit DONE marker", () => {
  const updates: string[] = [];
  const parser = new OpenAICompatibleStreamParser((_delta, accumulated) =>
    updates.push(accumulated),
  );
  parser.feed(
    [
      'data: {"choices":[{"delta":{"content":"译"}}]}',
      "",
      'data: {"choices":[{"delta":{"content":"文"}}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
  );
  assert.equal(parser.finish().text, "译文");
  assert.deepEqual(updates, ["译", "译文"]);

  const incomplete = new OpenAICompatibleStreamParser();
  incomplete.feed('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  assert.throws(() => incomplete.finish(), /without \[DONE\]/u);
});

test("reports unsupported web search before sending an API request", async () => {
  await assert.rejects(
    runOpenAICompatibleRequest({
      apiBase: "https://api.deepseek.com/v1",
      apiKey: "secret",
      model: "deepseek-chat",
      instructions: "Research.",
      prompt: "Search.",
      webSearch: true,
      fetchFn: async () => {
        assert.fail("unsupported web search must not send a request");
      },
    }),
    /does not define web search/u,
  );
});

test("also rejects a required web-search capability before sending", async () => {
  await assert.rejects(
    runOpenAICompatibleRequest({
      apiBase: "https://api.example.com/v1",
      apiKey: "secret",
      model: "example-model",
      instructions: "Research.",
      prompt: "Search.",
      requireWebSearch: true,
      fetchFn: async () => {
        assert.fail("required web search must not send a request");
      },
    }),
    /does not define web search/u,
  );
});

test("redacts the configured API key from endpoint error details", async () => {
  const apiKey = "secret-key-that-must-not-leak";
  await assert.rejects(
    runOpenAICompatibleRequest({
      apiBase: "https://api.example.com/v1",
      apiKey,
      model: "example-model",
      instructions: "Translate.",
      prompt: "text",
      fetchFn: async () =>
        new Response(`invalid credential: ${apiKey}`, {
          status: 401,
          statusText: "Unauthorized",
        }),
    }),
    (error: unknown) => {
      assert.match(String(error), /\[API KEY REDACTED\]/u);
      assert.doesNotMatch(String(error), new RegExp(apiKey, "u"));
      return true;
    },
  );
});

test("redacts the configured API key from streamed endpoint errors", async () => {
  const apiKey = "stream-secret-that-must-not-leak";
  const body = `data: ${JSON.stringify({
    error: { message: `invalid credential ${apiKey}` },
  })}\n\n`;
  await assert.rejects(
    runOpenAICompatibleRequest({
      apiBase: "https://api.example.com/v1",
      apiKey,
      model: "example-model",
      instructions: "Translate.",
      prompt: "text",
      fetchFn: async () =>
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    }),
    (error: unknown) => {
      assert.match(String(error), /\[API KEY REDACTED\]/u);
      assert.doesNotMatch(String(error), new RegExp(apiKey, "u"));
      return true;
    },
  );
});

test("rejects an oversized HTTP error body at the transport boundary", async () => {
  await assert.rejects(
    runOpenAICompatibleRequest({
      apiBase: "https://api.example.com/v1",
      apiKey: "secret",
      model: "example-model",
      instructions: "Translate.",
      prompt: "text",
      fetchFn: async () =>
        new Response("x".repeat(65_537), {
          status: 500,
          statusText: "Server Error",
        }),
    }),
    /error response exceeded the 65536-byte limit/u,
  );
});

test("finishes at DONE without waiting for the provider to close the stream", async () => {
  let cancelled = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          [
            'data: {"choices":[{"delta":{"content":"译文"}}]}',
            "",
            "data: [DONE]",
            "",
            "",
          ].join("\n"),
        ),
      );
    },
    cancel() {
      cancelled = true;
    },
  });

  const result = await runOpenAICompatibleRequest({
    apiBase: "https://api.example.com/v1",
    apiKey: "secret",
    model: "example-model",
    instructions: "Translate.",
    prompt: "text",
    fetchFn: async () =>
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
  });

  assert.equal(result.text, "译文");
  assert.equal(cancelled, true);
});
