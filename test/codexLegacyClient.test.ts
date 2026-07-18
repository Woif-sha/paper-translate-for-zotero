import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexResponsesStreamParser,
  DEFAULT_CODEX_API_URL,
  buildLegacyCodexPayload,
  cancelActiveCodexAuthRefreshes,
  normalizeEffort,
  runLegacyCodexRequest,
  testLegacyCodexConnection,
  type LegacyCodexRequest,
} from "../src/codex/legacyClient";

test("matches llm-for-zotero legacy endpoint and automatic reasoning", () => {
  assert.equal(
    DEFAULT_CODEX_API_URL,
    "https://chatgpt.com/backend-api/codex/responses",
  );
  assert.equal(normalizeEffort("auto"), undefined);
  assert.equal(normalizeEffort(""), undefined);
  assert.equal(normalizeEffort("high"), "high");
});

test("builds the legacy Codex Responses streaming payload", () => {
  const request = {
    model: "gpt-5.4",
    effort: "high",
    instructions: "Translate faithfully.",
    prompt: "source",
    webSearch: true,
    maxOutputCharacters: 8_000,
    maxResponseBytes: 1_000_000,
    maxObservedWebSearchCalls: 3,
  };
  assert.deepEqual(buildLegacyCodexPayload(request), {
    model: "gpt-5.4",
    instructions: "Translate faithfully.",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "source" }],
      },
    ],
    store: false,
    stream: true,
    reasoning: { effort: "high" },
    tools: [{ type: "web_search" }],
    tool_choice: "auto",
  });
});

test("connection test does not spend its response budget on reasoning", async () => {
  const previousServices = (globalThis as any).Services;
  const previousIO = (globalThis as any).IOUtils;
  const previousToolkit = (globalThis as any).ztoolkit;
  let payload: Record<string, unknown> | undefined;
  const successfulStream = [
    'data: {"type":"response.output_text.delta","delta":"OK"}',
    "",
    'data: {"type":"response.completed","response":{}}',
    "",
  ].join("\n");
  (globalThis as any).Services = { env: { get: () => "E:\\Codex" } };
  (globalThis as any).IOUtils = {
    async read() {
      return new TextEncoder().encode(
        JSON.stringify({
          tokens: { access_token: "access", refresh_token: "refresh" },
        }),
      );
    },
    async write() {
      throw new Error("connection test must not write Codex auth");
    },
  };
  (globalThis as any).ztoolkit = {
    getGlobal() {
      return async (_url: string, init: RequestInit) => {
        payload = JSON.parse(String(init.body));
        return new Response(successfulStream, { status: 200 });
      };
    },
  };
  try {
    assert.equal(
      await testLegacyCodexConnection({
        apiUrl: DEFAULT_CODEX_API_URL,
        model: "gpt-5.4",
        effort: "medium",
      }),
      "OK",
    );
    assert.equal(payload?.reasoning, undefined);
    assert.equal(payload?.max_output_tokens, undefined);
    assert.equal(payload?.max_tool_calls, undefined);
  } finally {
    cancelActiveCodexAuthRefreshes();
    (globalThis as any).Services = previousServices;
    (globalThis as any).IOUtils = previousIO;
    (globalThis as any).ztoolkit = previousToolkit;
  }
});

test("parses legacy Codex text and web-search stream events", () => {
  const updates: string[] = [];
  const parser = new CodexResponsesStreamParser((_delta, accumulated) =>
    updates.push(accumulated),
  );
  parser.feed(
    [
      'data: {"type":"response.output_item.added","item":{"type":"web_search_call"}}',
      "",
      'data: {"type":"response.output_text.delta","delta":"译"}',
      "",
      'data: {"type":"response.output_text.delta","delta":"文"}',
      "",
      'data: {"type":"response.output_text.annotation.added","annotation":{"type":"url_citation","url":"https://example.org/source","title":"Source"}}',
      "",
      'data: {"type":"response.completed","response":{}}',
      "",
    ].join("\n"),
  );
  assert.deepEqual(parser.finish(), {
    text: "译文",
    usedWebSearch: true,
    webSearchCalls: 1,
    citedUrls: ["https://example.org/source"],
  });
  assert.deepEqual(updates, ["译", "译文"]);
});

test("stops a web research stream after the configured search count", () => {
  const parser = new CodexResponsesStreamParser(undefined, {
    maxObservedWebSearchCalls: 1,
  });
  assert.throws(() => {
    parser.feed(
      'data: {"type":"response.output_item.added","item":{"id":"one","type":"web_search_call"}}\n\n',
    );
    parser.feed(
      'data: {"type":"response.output_item.added","item":{"id":"two","type":"web_search_call"}}\n\n',
    );
  }, /exceeded the 1-call limit/);
});

test("does not count the same web search call ID twice", () => {
  const parser = new CodexResponsesStreamParser(undefined, {
    maxObservedWebSearchCalls: 1,
  });
  const event =
    'data: {"type":"response.output_item.added","item":{"id":"one","type":"web_search_call"}}\n\n';
  parser.feed(event);
  parser.feed(event);
  parser.feed(
    'data: {"type":"response.output_text.delta","delta":"done"}\n\ndata: {"type":"response.completed","response":{}}\n\n',
  );
  assert.equal(parser.finish().webSearchCalls, 1);
});

test("enforces the visible output character boundary", () => {
  const exact = new CodexResponsesStreamParser(undefined, {
    maxOutputCharacters: 2,
  });
  exact.feed(
    'data: {"type":"response.output_text.delta","delta":"译文"}\n\ndata: {"type":"response.completed","response":{}}\n\n',
  );
  assert.equal(exact.finish().text, "译文");

  const overflow = new CodexResponsesStreamParser(undefined, {
    maxOutputCharacters: 1,
  });
  assert.throws(
    () =>
      overflow.feed(
        'data: {"type":"response.output_text.delta","delta":"译文"}\n\n',
      ),
    /exceeded the 1-character limit/,
  );
});

test("rejects a legacy stream without a completion event", () => {
  const parser = new CodexResponsesStreamParser();
  parser.feed('data: {"type":"response.output_text.delta","delta":"x"}\n\n');
  assert.throws(() => parser.finish(), /without completion/);
});

test("parses SSE when CRLF delimiters are split across chunks", () => {
  const parser = new CodexResponsesStreamParser();
  const stream = [
    'data: {"type":"response.output_text.delta","delta":"x"}',
    "",
    'data: {"type":"response.completed","response":{}}',
    "",
  ].join("\r\n");
  for (const character of stream) parser.feed(character);
  assert.equal(parser.finish().text, "x");
});

test("cancels a legacy stream that exceeds the local response byte limit", async () => {
  await assertLegacyStreamLimitCancels({
    chunk: "too large",
    limits: { maxResponseBytes: 1 },
    expected: /exceeded the 1-byte limit/,
  });
});

test("cancels a legacy stream that exceeds the visible output limit", async () => {
  await assertLegacyStreamLimitCancels({
    chunk:
      'data: {"type":"response.output_text.delta","delta":"too large"}\n\n',
    limits: { maxOutputCharacters: 1 },
    expected: /exceeded the 1-character limit/,
  });
});

test("cancels a legacy stream after too many observed web searches", async () => {
  await assertLegacyStreamLimitCancels({
    chunk: [
      'data: {"type":"response.output_item.added","item":{"id":"one","type":"web_search_call"}}',
      "",
      'data: {"type":"response.output_item.added","item":{"id":"two","type":"web_search_call"}}',
      "",
      "",
    ].join("\n"),
    limits: { webSearch: true, maxObservedWebSearchCalls: 1 },
    expected: /exceeded the 1-call limit/,
  });
});

async function assertLegacyStreamLimitCancels(params: {
  chunk: string;
  limits: Partial<
    Pick<
      LegacyCodexRequest,
      | "webSearch"
      | "maxOutputCharacters"
      | "maxResponseBytes"
      | "maxObservedWebSearchCalls"
    >
  >;
  expected: RegExp;
}): Promise<void> {
  const previousServices = (globalThis as any).Services;
  const previousIO = (globalThis as any).IOUtils;
  const previousToolkit = (globalThis as any).ztoolkit;
  let cancelled = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  (globalThis as any).Services = { env: { get: () => "E:\\Codex" } };
  (globalThis as any).IOUtils = {
    async read() {
      return new TextEncoder().encode(
        JSON.stringify({
          tokens: { access_token: "access", refresh_token: "refresh" },
        }),
      );
    },
    async write() {
      throw new Error("response limit test must not write Codex auth");
    },
  };
  (globalThis as any).ztoolkit = {
    getGlobal() {
      return async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(params.chunk));
              closeTimer = setTimeout(() => controller.close(), 20);
            },
            cancel() {
              if (closeTimer !== undefined) clearTimeout(closeTimer);
              cancelled = true;
            },
          }),
          { status: 200 },
        );
    },
  };
  try {
    await assert.rejects(
      runLegacyCodexRequest({
        apiUrl: DEFAULT_CODEX_API_URL,
        model: "gpt-5.4",
        instructions: "Reply with OK.",
        prompt: "OK",
        ...params.limits,
      }),
      params.expected,
    );
    assert.equal(cancelled, true);
  } finally {
    cancelActiveCodexAuthRefreshes();
    (globalThis as any).Services = previousServices;
    (globalThis as any).IOUtils = previousIO;
    (globalThis as any).ztoolkit = previousToolkit;
  }
}

test("does not retry a rejected legacy request with a different payload", async () => {
  const previousServices = (globalThis as any).Services;
  const previousIO = (globalThis as any).IOUtils;
  const previousToolkit = (globalThis as any).ztoolkit;
  let calls = 0;
  let payload: Record<string, unknown> | undefined;
  (globalThis as any).Services = { env: { get: () => "E:\\Codex" } };
  (globalThis as any).IOUtils = {
    async read() {
      return new TextEncoder().encode(
        JSON.stringify({
          tokens: { access_token: "access", refresh_token: "refresh" },
        }),
      );
    },
    async write() {
      throw new Error("HTTP 400 must not write Codex auth");
    },
  };
  (globalThis as any).ztoolkit = {
    getGlobal() {
      return async (_url: string, init: RequestInit) => {
        calls += 1;
        payload = JSON.parse(String(init.body));
        return new Response(
          '{"detail":"Unsupported parameter: max_output_tokens"}',
          { status: 400, statusText: "Bad Request" },
        );
      };
    },
  };
  try {
    await assert.rejects(
      runLegacyCodexRequest({
        apiUrl: DEFAULT_CODEX_API_URL,
        model: "gpt-5.4",
        effort: "medium",
        instructions: "Analyze the paper.",
        prompt: "paper",
        maxOutputCharacters: 16_000,
        maxResponseBytes: 2_000_000,
      }),
      /Unsupported parameter: max_output_tokens/,
    );
    assert.equal(calls, 1);
    assert.equal(payload?.max_output_tokens, undefined);
    assert.equal(payload?.max_tool_calls, undefined);
  } finally {
    cancelActiveCodexAuthRefreshes();
    (globalThis as any).Services = previousServices;
    (globalThis as any).IOUtils = previousIO;
    (globalThis as any).ztoolkit = previousToolkit;
  }
});

test("shares one atomic Codex token refresh across concurrent requests", async () => {
  const previousServices = (globalThis as any).Services;
  const previousIO = (globalThis as any).IOUtils;
  const previousToolkit = (globalThis as any).ztoolkit;
  let authDocument: Record<string, any> = {
    tokens: { access_token: "old-access", refresh_token: "old-refresh" },
  };
  let refreshCalls = 0;
  let authWrites = 0;
  const successfulStream = [
    'data: {"type":"response.output_text.delta","delta":"OK"}',
    "",
    'data: {"type":"response.completed","response":{}}',
    "",
  ].join("\n");
  (globalThis as any).Services = {
    env: { get: (name: string) => (name === "CODEX_HOME" ? "E:\\Codex" : "") },
  };
  (globalThis as any).IOUtils = {
    async read() {
      return new TextEncoder().encode(JSON.stringify(authDocument));
    },
    async write(_path: string, data: Uint8Array) {
      authWrites += 1;
      authDocument = JSON.parse(new TextDecoder().decode(data));
    },
  };
  (globalThis as any).ztoolkit = {
    getGlobal(name: string) {
      assert.equal(name, "fetch");
      return async (url: string, init: RequestInit) => {
        if (url.includes("/oauth/token")) {
          refreshCalls += 1;
          await new Promise<void>((resolve) => setImmediate(resolve));
          return Response.json({
            access_token: "new-access",
            refresh_token: "new-refresh",
          });
        }
        const authorization = (init.headers as Record<string, string>)[
          "Authorization"
        ];
        return authorization === "Bearer old-access"
          ? new Response("unauthorized", { status: 401 })
          : new Response(successfulStream, { status: 200 });
      };
    },
  };
  const params = {
    apiUrl: DEFAULT_CODEX_API_URL,
    model: "gpt-5.4",
    instructions: "Reply with OK.",
    prompt: "OK",
  };
  try {
    const results = await Promise.all([
      runLegacyCodexRequest(params),
      runLegacyCodexRequest(params),
    ]);
    assert.deepEqual(
      results.map((result) => result.text),
      ["OK", "OK"],
    );
    assert.equal(refreshCalls, 1);
    assert.equal(authWrites, 1);
    assert.equal(authDocument.tokens.access_token, "new-access");
    assert.equal(authDocument.tokens.refresh_token, "new-refresh");
  } finally {
    cancelActiveCodexAuthRefreshes();
    (globalThis as any).Services = previousServices;
    (globalThis as any).IOUtils = previousIO;
    (globalThis as any).ztoolkit = previousToolkit;
  }
});

test("preserves a Codex CLI token changed while OAuth refresh is running", async () => {
  const previousServices = (globalThis as any).Services;
  const previousIO = (globalThis as any).IOUtils;
  const previousToolkit = (globalThis as any).ztoolkit;
  let notifyRefreshStarted = () => {};
  let finishRefresh = () => {};
  const refreshStarted = new Promise<void>((resolve) => {
    notifyRefreshStarted = resolve;
  });
  const refreshMayFinish = new Promise<void>((resolve) => {
    finishRefresh = resolve;
  });
  let authDocument: Record<string, any> = {
    tokens: { access_token: "old-access", refresh_token: "old-refresh" },
  };
  let authWrites = 0;
  const requestTokens: string[] = [];
  const successfulStream = [
    'data: {"type":"response.output_text.delta","delta":"OK"}',
    "",
    'data: {"type":"response.completed","response":{}}',
    "",
  ].join("\n");
  (globalThis as any).Services = {
    env: { get: (name: string) => (name === "CODEX_HOME" ? "E:\\Codex" : "") },
  };
  (globalThis as any).IOUtils = {
    async read() {
      return new TextEncoder().encode(JSON.stringify(authDocument));
    },
    async write(_path: string, data: Uint8Array) {
      authWrites += 1;
      authDocument = JSON.parse(new TextDecoder().decode(data));
    },
  };
  (globalThis as any).ztoolkit = {
    getGlobal(name: string) {
      assert.equal(name, "fetch");
      return async (url: string, init: RequestInit) => {
        if (url.includes("/oauth/token")) {
          notifyRefreshStarted();
          await refreshMayFinish;
          return Response.json({
            access_token: "plugin-new",
            refresh_token: "plugin-refresh",
          });
        }
        const authorization = (init.headers as Record<string, string>)[
          "Authorization"
        ];
        requestTokens.push(authorization);
        if (authorization === "Bearer old-access") {
          return new Response("unauthorized", { status: 401 });
        }
        assert.equal(authorization, "Bearer cli-new");
        return new Response(successfulStream, { status: 200 });
      };
    },
  };
  const running = runLegacyCodexRequest({
    apiUrl: DEFAULT_CODEX_API_URL,
    model: "gpt-5.4",
    instructions: "Reply with OK.",
    prompt: "OK",
  });
  try {
    await refreshStarted;
    authDocument = {
      ...authDocument,
      tokens: { ...authDocument.tokens, access_token: "cli-new" },
    };
    finishRefresh();
    assert.equal((await running).text, "OK");
    assert.deepEqual(requestTokens, ["Bearer old-access", "Bearer cli-new"]);
    assert.equal(authWrites, 0);
    assert.equal(authDocument.tokens.access_token, "cli-new");
    assert.equal(authDocument.tokens.refresh_token, "old-refresh");
  } finally {
    finishRefresh();
    cancelActiveCodexAuthRefreshes();
    (globalThis as any).Services = previousServices;
    (globalThis as any).IOUtils = previousIO;
    (globalThis as any).ztoolkit = previousToolkit;
  }
});

test("does not write auth after a resolved refresh response is cancelled", async () => {
  const previousServices = (globalThis as any).Services;
  const previousIO = (globalThis as any).IOUtils;
  const previousToolkit = (globalThis as any).ztoolkit;
  let notifyJsonStarted = () => {};
  let releaseJson = () => {};
  const jsonStarted = new Promise<void>((resolve) => {
    notifyJsonStarted = resolve;
  });
  const jsonMayFinish = new Promise<void>((resolve) => {
    releaseJson = resolve;
  });
  let authWrites = 0;
  (globalThis as any).Services = {
    env: { get: () => "E:\\Codex" },
  };
  (globalThis as any).IOUtils = {
    async read() {
      return new TextEncoder().encode(
        JSON.stringify({
          tokens: { access_token: "old-access", refresh_token: "refresh" },
        }),
      );
    },
    async write() {
      authWrites += 1;
    },
  };
  (globalThis as any).ztoolkit = {
    getGlobal() {
      return async (url: string) => {
        if (!url.includes("/oauth/token")) {
          return new Response("unauthorized", { status: 401 });
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          async json() {
            notifyJsonStarted();
            await jsonMayFinish;
            return { access_token: "must-not-be-written" };
          },
        } as Response;
      };
    },
  };
  const running = runLegacyCodexRequest({
    apiUrl: DEFAULT_CODEX_API_URL,
    model: "gpt-5.4",
    instructions: "Reply with OK.",
    prompt: "OK",
  });
  try {
    await jsonStarted;
    cancelActiveCodexAuthRefreshes();
    releaseJson();
    await assert.rejects(running, /refresh was cancelled/);
    assert.equal(authWrites, 0);
  } finally {
    releaseJson();
    cancelActiveCodexAuthRefreshes();
    (globalThis as any).Services = previousServices;
    (globalThis as any).IOUtils = previousIO;
    (globalThis as any).ztoolkit = previousToolkit;
  }
});

test("honors cancellation while rereading auth before refresh", async () => {
  const previousServices = (globalThis as any).Services;
  const previousIO = (globalThis as any).IOUtils;
  const previousToolkit = (globalThis as any).ztoolkit;
  let notifyReadStarted = () => {};
  let releaseRead = () => {};
  const readStarted = new Promise<void>((resolve) => {
    notifyReadStarted = resolve;
  });
  const readMayFinish = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let reads = 0;
  let authDocument = {
    tokens: { access_token: "old-access", refresh_token: "refresh" },
  };
  let oauthCalls = 0;
  (globalThis as any).Services = { env: { get: () => "E:\\Codex" } };
  (globalThis as any).IOUtils = {
    async read() {
      reads += 1;
      if (reads === 2) {
        notifyReadStarted();
        await readMayFinish;
      }
      return new TextEncoder().encode(JSON.stringify(authDocument));
    },
    async write() {
      throw new Error("cancelled refresh must not write auth");
    },
  };
  (globalThis as any).ztoolkit = {
    getGlobal() {
      return async (url: string) => {
        if (url.includes("/oauth/token")) oauthCalls += 1;
        return new Response("unauthorized", { status: 401 });
      };
    },
  };
  const running = runLegacyCodexRequest({
    apiUrl: DEFAULT_CODEX_API_URL,
    model: "gpt-5.4",
    instructions: "Reply with OK.",
    prompt: "OK",
  });
  try {
    await readStarted;
    authDocument = {
      tokens: { access_token: "cli-new", refresh_token: "cli-refresh" },
    };
    cancelActiveCodexAuthRefreshes();
    releaseRead();
    await assert.rejects(running, /refresh was cancelled/);
    assert.equal(oauthCalls, 0);
  } finally {
    releaseRead();
    cancelActiveCodexAuthRefreshes();
    (globalThis as any).Services = previousServices;
    (globalThis as any).IOUtils = previousIO;
    (globalThis as any).ztoolkit = previousToolkit;
  }
});

test("does not restore credentials removed by Codex CLI during refresh", async () => {
  const previousServices = (globalThis as any).Services;
  const previousIO = (globalThis as any).IOUtils;
  const previousToolkit = (globalThis as any).ztoolkit;
  let notifyRefreshStarted = () => {};
  let finishRefresh = () => {};
  const refreshStarted = new Promise<void>((resolve) => {
    notifyRefreshStarted = resolve;
  });
  const refreshMayFinish = new Promise<void>((resolve) => {
    finishRefresh = resolve;
  });
  let authDocument: Record<string, any> = {
    tokens: { access_token: "old-access", refresh_token: "old-refresh" },
  };
  let authWrites = 0;
  (globalThis as any).Services = { env: { get: () => "E:\\Codex" } };
  (globalThis as any).IOUtils = {
    async read() {
      return new TextEncoder().encode(JSON.stringify(authDocument));
    },
    async write() {
      authWrites += 1;
    },
  };
  (globalThis as any).ztoolkit = {
    getGlobal() {
      return async (url: string) => {
        if (!url.includes("/oauth/token")) {
          return new Response("unauthorized", { status: 401 });
        }
        notifyRefreshStarted();
        await refreshMayFinish;
        return Response.json({
          access_token: "plugin-new",
          refresh_token: "plugin-refresh",
        });
      };
    },
  };
  const running = runLegacyCodexRequest({
    apiUrl: DEFAULT_CODEX_API_URL,
    model: "gpt-5.4",
    instructions: "Reply with OK.",
    prompt: "OK",
  });
  try {
    await refreshStarted;
    authDocument = { tokens: {} };
    finishRefresh();
    await assert.rejects(running, /auth changed during token refresh/);
    assert.equal(authWrites, 0);
    assert.deepEqual(authDocument.tokens, {});
  } finally {
    finishRefresh();
    cancelActiveCodexAuthRefreshes();
    (globalThis as any).Services = previousServices;
    (globalThis as any).IOUtils = previousIO;
    (globalThis as any).ztoolkit = previousToolkit;
  }
});

test("cancels a hung shared Codex token refresh", async () => {
  const previousServices = (globalThis as any).Services;
  const previousIO = (globalThis as any).IOUtils;
  const previousToolkit = (globalThis as any).ztoolkit;
  let notifyRefreshStarted = () => {};
  const refreshStarted = new Promise<void>((resolve) => {
    notifyRefreshStarted = resolve;
  });
  (globalThis as any).Services = {
    env: { get: () => "E:\\Codex" },
  };
  (globalThis as any).IOUtils = {
    async read() {
      return new TextEncoder().encode(
        JSON.stringify({
          tokens: { access_token: "old-access", refresh_token: "refresh" },
        }),
      );
    },
    async write() {
      throw new Error("cancelled refresh must not write auth");
    },
  };
  (globalThis as any).ztoolkit = {
    getGlobal() {
      return async (url: string, init: RequestInit) => {
        if (!url.includes("/oauth/token")) {
          return new Response("unauthorized", { status: 401 });
        }
        notifyRefreshStarted();
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        });
      };
    },
  };
  const running = runLegacyCodexRequest({
    apiUrl: DEFAULT_CODEX_API_URL,
    model: "gpt-5.4",
    instructions: "Reply with OK.",
    prompt: "OK",
  });
  try {
    await refreshStarted;
    cancelActiveCodexAuthRefreshes();
    await assert.rejects(running, /refresh was cancelled/);
  } finally {
    cancelActiveCodexAuthRefreshes();
    (globalThis as any).Services = previousServices;
    (globalThis as any).IOUtils = previousIO;
    (globalThis as any).ztoolkit = previousToolkit;
  }
});
