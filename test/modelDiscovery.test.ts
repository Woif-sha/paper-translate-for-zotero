import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchProviderModels,
  resolveModelCatalog,
} from "../src/models/modelDiscovery";
import { PROVIDER_PRESETS } from "../src/models/protocols";
import type { ModelProviderGroup } from "../src/models/providers";
import {
  DEFAULT_CODEX_API_URL,
  DEFAULT_CODEX_MODELS_URL,
  cancelActiveCodexAuthRefreshes,
} from "../src/codex/legacyClient";

function provider(
  overrides: Partial<ModelProviderGroup> = {},
): ModelProviderGroup {
  return {
    id: "p",
    name: "Example",
    authMode: "openai_compatible",
    apiBase: "https://example.test/prefix/v1/responses?api-version=2026",
    apiKey: "synthetic-secret-key",
    protocol: "responses",
    presetId: "custom",
    models: [],
    ...overrides,
  };
}
const json = (data: unknown) => new Response(JSON.stringify(data));

test("preserves valid declared output modalities while ignoring malformed optional metadata", async () => {
  const models = await fetchProviderModels(provider(), {
    fetchFn: async () =>
      json({
        data: [
          { id: "a", output_modalities: [" Image "] },
          { id: "b", output_modalities: ["text", "audio"] },
          { id: "c", output_modalities: [] },
          { id: "d", output_modalities: [null] },
          { id: "e", output_modalities: "image" },
        ],
      }),
  });
  assert.deepEqual([...models].reverse(), [
    { id: "a", name: "", outputModalities: ["image"] },
    { id: "b", name: "", outputModalities: ["text", "audio"] },
    { id: "c", name: "" },
    { id: "d", name: "" },
    { id: "e", name: "" },
  ]);
});

test("all seven presets use their own official catalog URL and catalog authentication", () => {
  for (const preset of PROVIDER_PRESETS) {
    const catalog = resolveModelCatalog(
      provider({
        presetId: preset.id,
        apiBase: preset.url,
        protocol: preset.protocol,
      }),
    );
    const expected = preset.id.startsWith("deepseek-")
      ? "https://api.deepseek.com/models"
      : preset.id.startsWith("anthropic-")
        ? "https://api.anthropic.com/v1/models"
        : "https://api.openai.com/v1/models";
    assert.equal(catalog.url, expected, preset.id);
    const anthropic = preset.id.startsWith("anthropic-");
    assert.equal(catalog.paginated, anthropic);
    assert.equal(
      catalog.headers.Authorization,
      anthropic ? undefined : "Bearer synthetic-secret-key",
    );
    assert.equal(
      catalog.headers["x-api-key"],
      anthropic ? "synthetic-secret-key" : undefined,
    );
    assert.equal(
      catalog.headers["anthropic-version"],
      anthropic ? "2023-06-01" : undefined,
    );
  }
});

test("custom catalogs preserve gateway prefixes, query parameters and explicit authentication", () => {
  for (const [protocol, path] of [
    ["responses", "responses"],
    ["chat_completions", "chat/completions"],
    ["anthropic_messages", "messages"],
  ] as const) {
    const catalog = resolveModelCatalog(
      provider({
        protocol,
        apiBase: `https://proxy.test/api/v1/${path}?region=local`,
      }),
    );
    assert.equal(catalog.url, "https://proxy.test/api/v1/models?region=local");
    assert.equal(catalog.paginated, protocol === "anthropic_messages");
  }
  assert.equal(
    resolveModelCatalog(
      provider({ apiBase: "https://proxy.test", protocol: "responses" }),
    ).url,
    "https://proxy.test/v1/models",
  );
  // A stale preset ID must never send a proxy's key to that preset's official host.
  assert.equal(
    resolveModelCatalog(provider({ presetId: "openai-responses" })).url,
    "https://example.test/prefix/v1/models?api-version=2026",
  );
});

test("listing uses GET without generation, rejects redirects, sorts and deduplicates actual model IDs", async () => {
  let requests = 0;
  const models = await fetchProviderModels(provider(), {
    fetchFn: async (url, init) => {
      requests += 1;
      assert.equal(
        String(url),
        "https://example.test/prefix/v1/models?api-version=2026",
      );
      assert.equal(init?.method, "GET");
      assert.equal(init?.body, undefined);
      assert.equal(init?.redirect, "error");
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        "Bearer synthetic-secret-key",
      );
      return json({
        data: [
          { id: "model-b", name: "Model B" },
          { id: "model-a" },
          { id: "model-b" },
          { id: "embedding-model" },
        ],
      });
    },
  });
  assert.equal(requests, 1);
  assert.deepEqual(models, [
    { id: "model-b", name: "Model B" },
    { id: "model-a", name: "" },
    { id: "embedding-model", name: "" },
  ]);
});

test("Anthropic paginates using last_id while preserving gateway query parameters", async () => {
  let page = 0;
  const models = await fetchProviderModels(
    provider({
      protocol: "anthropic_messages",
      apiBase: "https://proxy.test/v1/messages?region=local",
    }),
    {
      fetchFn: async (url) => {
        page += 1;
        const endpoint = new URL(String(url));
        assert.equal(endpoint.searchParams.get("region"), "local");
        if (page === 1) {
          assert.equal(endpoint.searchParams.has("after_id"), false);
          return json({
            data: [{ id: "model-b", display_name: "Model B" }],
            has_more: true,
            last_id: "model-b",
          });
        }
        assert.equal(endpoint.searchParams.get("after_id"), "model-b");
        return json({
          data: [{ id: "model-a" }, { id: "model-b" }],
          has_more: false,
          last_id: "model-a",
        });
      },
    },
  );
  assert.equal(page, 2);
  assert.equal(models.length, 2);
  assert.equal(models.find((model) => model.id === "model-b")!.name, "Model B");
});

test("invalid endpoints and missing API keys never send a discovery request", async () => {
  for (const overrides of [
    { apiKey: "" },
    { authMode: "codex_auth" as const },
    { apiBase: "http://proxy.test/v1" },
    { apiBase: "https://user:password@proxy.test/v1" },
    { apiBase: "https://proxy.test/v1?api_key=secret" },
    { apiBase: "https://proxy.test/v1/messages" },
  ]) {
    await assert.rejects(
      fetchProviderModels(provider(overrides), {
        fetchFn: async () =>
          assert.fail("invalid settings cannot send credentials"),
      }),
    );
  }
});

test("Codex discovers listed slugs in descending natural version order without using server priority", async () => {
  await withCodexCatalog(async () => {
    const models = await fetchProviderModels(codexProvider(), {
      fetchFn: async (url, init) => {
        assert.equal(String(url), DEFAULT_CODEX_MODELS_URL);
        assert.equal(init?.method, "GET");
        assert.equal(init?.redirect, "error");
        assert.equal(
          (init?.headers as Record<string, string>).Authorization,
          "Bearer codex-discovery-access",
        );
        return json({
          models: [
            {
              slug: " gpt-5.6 ",
              display_name: " GPT-5.6 ",
              visibility: "list",
              priority: 100,
            },
            {
              slug: "gpt-6.1-sol",
              display_name: "GPT-6.1-Sol",
              visibility: "list",
              priority: 1,
            },
            { slug: "gpt-6-astra", visibility: "list", priority: 2 },
            {
              slug: "GPT-6.1-SOL",
              display_name: "Duplicate",
              visibility: "list",
              priority: 999,
            },
            { slug: "hidden", visibility: "hide", priority: 100 },
            { id: "public-api-shape", visibility: "list" },
          ],
        });
      },
    });
    assert.deepEqual(models, [
      { id: "gpt-6.1-sol", name: "GPT-6.1-Sol" },
      { id: "gpt-6-astra", name: "gpt-6-astra" },
      { id: "gpt-5.6", name: "GPT-5.6" },
    ]);
  });
});

test("Codex creation metadata takes precedence over server priority and model versions", async () => {
  await withCodexCatalog(async () => {
    const models = await fetchProviderModels(codexProvider(), {
      fetchFn: async () =>
        json({
          models: [
            {
              slug: "version-99",
              visibility: "list",
              priority: 100,
              created: 1727740800,
            },
            {
              slug: "version-1",
              visibility: "list",
              priority: 1,
              created_at: "2026-09-21T00:00:00Z",
            },
            { slug: "unknown-100", visibility: "list", priority: 200 },
          ],
        }),
    });
    assert.deepEqual(models, [
      {
        id: "version-1",
        name: "version-1",
        createdAt: Date.parse("2026-09-21T00:00:00Z"),
      },
      {
        id: "version-99",
        name: "version-99",
        createdAt: Date.parse("2024-10-01T00:00:00Z"),
      },
      { id: "unknown-100", name: "unknown-100" },
    ]);
  });
});

test("Codex accepts the upstream data envelope but never invents unavailable models", async () => {
  await withCodexCatalog(async () => {
    assert.deepEqual(
      await fetchProviderModels(codexProvider(), {
        fetchFn: async () =>
          json({ data: [{ slug: "actual", visibility: "list" }] }),
      }),
      [{ id: "actual", name: "actual" }],
    );
    for (const payload of [
      null,
      {},
      { models: [] },
      { models: [{ slug: "hidden", visibility: "hide" }] },
      { data: [{ id: "public-model" }] },
      { models: [{ slug: "bad\nmodel", visibility: "list" }] },
    ]) {
      await assert.rejects(
        fetchProviderModels(codexProvider(), {
          fetchFn: async () => json(payload),
        }),
      );
    }
  });
});

test("Codex rejects a changed responses address before reading auth or fetching", async () => {
  await assert.rejects(
    fetchProviderModels(
      codexProvider({ apiBase: "https://proxy.test/responses" }),
      {
        fetchFn: async () =>
          assert.fail("must not send Codex credentials to a proxy"),
      },
    ),
    /Codex.*URL|Codex.*address/i,
  );
});

test("Codex HTTP and malformed JSON errors cannot disclose server bodies or credentials", async () => {
  await withCodexCatalog(async () => {
    for (const response of [
      new Response("codex-discovery-access", { status: 403 }),
      new Response("codex-discovery-access"),
    ]) {
      await assert.rejects(
        fetchProviderModels(codexProvider(), { fetchFn: async () => response }),
        (error: Error) => !error.message.includes("codex-discovery-access"),
      );
    }
  });
});

test("Codex catalog keeps the response, model count and request lifetime limits", async () => {
  await withCodexCatalog(async () => {
    for (const response of [
      json({
        models: Array.from({ length: 5001 }, (_, i) => ({
          slug: `m${i}`,
          visibility: "list",
        })),
      }),
      new Response("x".repeat(2 * 1024 * 1024 + 1)),
    ]) {
      await assert.rejects(
        fetchProviderModels(codexProvider(), { fetchFn: async () => response }),
        /too large/,
      );
    }
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await assert.rejects(
      fetchProviderModels(codexProvider(), {
        signal: controller.signal,
        fetchFn: async () => assert.fail("cancelled"),
      }),
      /cancelled/,
    );
    let requestSignal: AbortSignal | undefined;
    await assert.rejects(
      fetchProviderModels(codexProvider(), {
        timeoutMs: 10,
        fetchFn: async (_url, init) => {
          requestSignal = init?.signal as AbortSignal;
          return new Promise<Response>(() => undefined);
        },
      }),
      /timed out/,
    );
    assert.equal(requestSignal?.aborted, true);
  });
});

function codexProvider(
  overrides: Partial<ModelProviderGroup> = {},
): ModelProviderGroup {
  return provider({
    authMode: "codex_auth",
    apiBase: DEFAULT_CODEX_API_URL,
    apiKey: "",
    ...overrides,
  });
}

async function withCodexCatalog(run: () => Promise<void>): Promise<void> {
  const previousServices = (globalThis as any).Services;
  const previousIO = (globalThis as any).IOUtils;
  (globalThis as any).Services = { env: { get: () => "E:\\DiscoveryTest" } };
  (globalThis as any).IOUtils = {
    async read() {
      return new TextEncoder().encode(
        JSON.stringify({
          tokens: {
            access_token: "codex-discovery-access",
            refresh_token: "codex-discovery-refresh",
          },
        }),
      );
    },
    async write() {
      assert.fail("successful catalog discovery must not rewrite auth");
    },
  };
  try {
    await run();
  } finally {
    cancelActiveCodexAuthRefreshes();
    (globalThis as any).Services = previousServices;
    (globalThis as any).IOUtils = previousIO;
  }
}

test("HTTP failures expose status and manual entry guidance without echoing keys or server error bodies", async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    await assert.rejects(
      fetchProviderModels(provider(), {
        fetchFn: async () =>
          new Response("<html>synthetic-secret-key</html>", { status }),
      }),
      (error: Error) =>
        error.message.includes(String(status)) &&
        error.message.includes("手动添加") &&
        !error.message.includes("synthetic-secret-key"),
    );
  }
  await assert.rejects(
    fetchProviderModels(provider(), {
      fetchFn: async () => {
        throw new Error("network synthetic-secret-key");
      },
    }),
    (error: Error) => !error.message.includes("synthetic-secret-key"),
  );
});

test("empty, malformed and invalid lists fail rather than inventing models", async () => {
  for (const value of [
    null,
    {},
    { data: [] },
    { data: [{}] },
    { data: [{ id: "" }] },
    { data: [{ id: "bad\nmodel" }] },
    { data: [{ id: "a" }], has_more: "true" },
  ]) {
    await assert.rejects(
      fetchProviderModels(provider(), { fetchFn: async () => json(value) }),
    );
  }
  await assert.rejects(
    fetchProviderModels(provider(), {
      fetchFn: async () => new Response("<html>login</html>"),
    }),
    /Invalid model JSON/,
  );
});

test("oversized lists and responses are bounded", async () => {
  await assert.rejects(
    fetchProviderModels(provider(), {
      fetchFn: async () =>
        json({
          data: Array.from({ length: 5001 }, (_, i) => ({ id: `model-${i}` })),
        }),
    }),
    /too large/,
  );
  await assert.rejects(
    fetchProviderModels(provider(), {
      fetchFn: async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
    }),
    /too large/,
  );
});

test("malformed, repeated and unbounded pagination never returns a partial success", async () => {
  for (const payload of [
    { data: [{ id: "a" }], has_more: true },
    { data: [{ id: "a" }], has_more: true, last_id: "unknown" },
    { data: [{ id: "a" }], has_more: true, last_id: "a" },
  ]) {
    await assert.rejects(
      fetchProviderModels(
        provider({
          protocol: "anthropic_messages",
          apiBase: "https://proxy.test/v1/messages",
        }),
        { fetchFn: async () => json(payload) },
      ),
      /pagination/,
    );
  }
  let pages = 0;
  await assert.rejects(
    fetchProviderModels(
      provider({
        protocol: "anthropic_messages",
        apiBase: "https://proxy.test/v1/messages",
      }),
      {
        fetchFn: async () => {
          pages += 1;
          return json({
            data: [{ id: `m${pages}` }],
            has_more: true,
            last_id: `m${pages}`,
          });
        },
      },
    ),
    /Too many model pages/,
  );
  assert.equal(pages, 10);
});

test("pre-cancelled discovery sends no request and a stuck transport has a finite deadline", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(
    fetchProviderModels(provider(), {
      signal: controller.signal,
      fetchFn: async () => assert.fail("cancelled"),
    }),
    /cancelled/,
  );
  let signal: AbortSignal | undefined;
  await assert.rejects(
    fetchProviderModels(provider(), {
      timeoutMs: 10,
      fetchFn: async (_url, init) => {
        signal = init?.signal as AbortSignal;
        return new Promise<Response>(() => undefined);
      },
    }),
    /timed out/,
  );
  assert.equal(signal?.aborted, true);
});
