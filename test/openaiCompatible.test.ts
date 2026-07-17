import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIStreamParser } from "../src/backends/openaiCompatible";

test("parses Responses API SSE across chunk boundaries", () => {
  let text = "";
  const parser = new OpenAIStreamParser(
    "responses",
    (delta) => (text += delta),
  );
  parser.feed(
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"译',
  );
  parser.feed('文"}\n\ndata: {"type":"response.completed"}\n\n');
  parser.finish();
  assert.equal(text, "译文");
});

test("parses Chat Completions SSE and requires completion", () => {
  let text = "";
  const parser = new OpenAIStreamParser(
    "chat-completions",
    (delta) => (text += delta),
  );
  parser.feed(
    'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
  );
  parser.feed('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
  parser.finish();
  assert.equal(text, "ok");
});

test("surfaces malformed final SSE instead of dropping it", () => {
  const parser = new OpenAIStreamParser("responses", () => undefined);
  parser.feed("data: {bad json}");
  assert.throws(() => parser.finish(), /Invalid SSE JSON/);
});
