import assert from "node:assert/strict";
import test from "node:test";
import {
  modelCreationTime,
  sortDiscoveredModels,
} from "../src/models/modelCatalogSort";
import { fetchProviderModels } from "../src/models/modelDiscovery";

test("normalizes OpenAI timestamps and Anthropic creation dates without inventing dates", () => {
  assert.equal(
    modelCreationTime({ created: 1727740800 }),
    Date.parse("2024-10-01T00:00:00Z"),
  );
  assert.equal(
    modelCreationTime({ created_at: "2026-09-21T00:00:00Z" }),
    Date.parse("2026-09-21T00:00:00Z"),
  );
  for (const value of [
    {},
    { created: 0 },
    { created: -1 },
    { created: Infinity },
    { created: "2026" },
    { created_at: "bad" },
  ]) {
    assert.equal(modelCreationTime(value), undefined);
  }
});

test("orders dated models newest first, then undated versions naturally descending, without mutating input", () => {
  const input = [
    { id: "gpt-4", name: "", createdAt: 1 },
    { id: "gpt-100", name: "" },
    { id: "gpt-10", name: "" },
    { id: "gpt-5", name: "", createdAt: 3 },
    { id: "gpt-6", name: "", createdAt: 2 },
    { id: "gpt-6-luna", name: "" },
  ];
  assert.deepEqual(
    sortDiscoveredModels(input).map((model) => model.id),
    ["gpt-5", "gpt-6", "gpt-4", "gpt-100", "gpt-10", "gpt-6-luna"],
  );
  assert.equal(input[0].id, "gpt-4");
});

test("fetching reads creation metadata and sorts across pages instead of alphabetically", async () => {
  let page = 0;
  const models = await fetchProviderModels(
    {
      id: "p",
      name: "p",
      authMode: "openai_compatible",
      protocol: "anthropic_messages",
      apiBase: "https://example.test/v1/messages",
      apiKey: "fake-key",
      models: [],
    },
    {
      fetchFn: async () => {
        page += 1;
        return new Response(
          JSON.stringify(
            page === 1
              ? {
                  data: [{ id: "z-old", created_at: "2024-01-01T00:00:00Z" }],
                  has_more: true,
                  last_id: "z-old",
                }
              : {
                  data: [
                    { id: "a-new", created: 1767225600 },
                    { id: "custom-10" },
                    { id: "custom-2" },
                  ],
                  has_more: false,
                },
          ),
        );
      },
    },
  );
  assert.deepEqual(
    models.map((model) => model.id),
    ["a-new", "z-old", "custom-10", "custom-2"],
  );
  assert.equal(models[0].createdAt, Date.parse("2026-01-01T00:00:00Z"));
});
