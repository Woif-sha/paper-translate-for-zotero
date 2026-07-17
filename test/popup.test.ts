import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("uses equal fixed dimensions for source and translation textareas", async () => {
  const source = await readFile(
    new URL("../src/modules/popup.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /width: "320px"/);
  assert.match(source, /minWidth: "320px"/);
  assert.match(source, /maxWidth: "320px"/);
  assert.match(source, /height: "96px"/);
  assert.match(source, /minHeight: "96px"/);
  assert.match(source, /maxHeight: "96px"/);
  assert.match(source, /resize: "none"/);
  assert.doesNotMatch(source, /scrollHeight|function resize/);
});
