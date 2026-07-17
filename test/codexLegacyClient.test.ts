import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexResponsesStreamParser,
  DEFAULT_CODEX_API_URL,
  buildLegacyCodexPayload,
  normalizeEffort,
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
  assert.deepEqual(
    buildLegacyCodexPayload({
      model: "gpt-5.4",
      effort: "high",
      instructions: "Translate faithfully.",
      prompt: "source",
      webSearch: true,
    }),
    {
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
    },
  );
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
      'data: {"type":"response.completed","response":{}}',
      "",
    ].join("\n"),
  );
  assert.deepEqual(parser.finish(), { text: "译文", usedWebSearch: true });
  assert.deepEqual(updates, ["译", "译文"]);
});

test("rejects a legacy stream without a completion event", () => {
  const parser = new CodexResponsesStreamParser();
  parser.feed('data: {"type":"response.output_text.delta","delta":"x"}\n\n');
  assert.throws(() => parser.finish(), /without completion/);
});
