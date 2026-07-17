import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServerClient, normalizeEffort } from "../src/codex/appServer";

function createFakeProcess() {
  const writes: string[] = [];
  return {
    writes,
    process: {
      stdin: { write: (value: string) => writes.push(value) },
      stdout: { readString: async () => "" },
      kill: () => undefined,
    },
  };
}

test("correlates JSON-RPC responses by id", async () => {
  const fake = createFakeProcess();
  const client = CodexAppServerClient.forTest(fake.process);
  const request = client.sendRequest("model/list", {});
  const message = JSON.parse(fake.writes[0]);
  client.handleLineForTest(
    JSON.stringify({ id: message.id, result: { data: [] } }),
  );
  assert.deepEqual(await request, { data: [] });
});

test("rejects explicit app-server errors", async () => {
  const fake = createFakeProcess();
  const client = CodexAppServerClient.forTest(fake.process);
  const request = client.sendRequest("thread/start", {});
  const message = JSON.parse(fake.writes[0]);
  client.handleLineForTest(
    JSON.stringify({ id: message.id, error: { code: -1, message: "bad" } }),
  );
  await assert.rejects(request, /Codex app-server error/);
});

test("delivers notification payloads", () => {
  const fake = createFakeProcess();
  const client = CodexAppServerClient.forTest(fake.process);
  let delta = "";
  client.onNotification("item/agentMessage/delta", (params) => {
    delta = (params as { delta: string }).delta;
  });
  client.handleLineForTest(
    JSON.stringify({
      method: "item/agentMessage/delta",
      params: { delta: "译" },
    }),
  );
  assert.equal(delta, "译");
});

test("matches llm-for-zotero automatic reasoning semantics", () => {
  assert.equal(normalizeEffort("auto"), undefined);
  assert.equal(normalizeEffort(""), undefined);
  assert.equal(normalizeEffort("high"), "high");
});
