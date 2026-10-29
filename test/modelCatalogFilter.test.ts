import assert from "node:assert/strict";
import test from "node:test";
import { hideModelByDefault } from "../src/models/modelCatalogFilter";

test("hides the reported specialist and legacy completion models, including dated snapshots", () => {
  for (const id of [
    "text-embedding-ada-002",
    "text-embedding-3-small",
    "text-embedding-3-large",
    "tts-1",
    "tts-1-1106",
    "tts-1-hd",
    "tts-1-hd-1106",
    "whisper-1",
    "babbage-002",
    "davinci-002",
    "chatgpt-image-latest",
    "dall-e-3",
    "gpt-image-2",
    "gpt-image-2.5-flare",
    "gpt-4o-mini-tts-2025-03-20",
    "gpt-4o-audio-preview-2024-12-17",
    "gpt-realtime-2.1",
    "gpt-live-transcribe",
    "omni-moderation-2024-09-26",
    "text-moderation-stable",
    "openai/tts-1",
    "  TTS-1  ",
  ])
    assert.equal(hideModelByDefault({ id, name: "" }), true, id);
});

test("keeps general models and unknown aliases without broad keyword or vendor filtering", () => {
  for (const id of [
    "gpt-6-luna",
    "gpt-4o",
    "gpt-4o-mini",
    "chat-latest",
    "o3-mini",
    "gpt-5.3-codex",
    "claude-sonnet-4-5",
    "deepseek-chat",
    "deepseek-reasoner",
    "qwen3-vl",
    "my-image-chat",
    "audio-translator",
    "embedding-expert-chat",
    "vision-model",
    "my-provider/tts-1",
    "gpt-image-new-custom",
    "completely-new-model",
  ])
    assert.equal(
      hideModelByDefault({ id, name: "TTS image embedding audio" }),
      false,
      id,
    );
});

test("uses explicit non-text output metadata conservatively and never treats visibility as capability proof", () => {
  assert.equal(
    hideModelByDefault({ id: "custom", name: "", outputModalities: ["image"] }),
    true,
  );
  assert.equal(
    hideModelByDefault({
      id: "custom",
      name: "",
      outputModalities: ["audio", "video"],
    }),
    true,
  );
  assert.equal(
    hideModelByDefault({
      id: "custom",
      name: "",
      outputModalities: ["vector"],
    }),
    true,
  );
  for (const outputModalities of [
    undefined,
    [],
    ["text"],
    ["text", "audio"],
    ["future-type"],
    ["image", "future-type"],
  ]) {
    assert.equal(
      hideModelByDefault({ id: "custom", name: "", outputModalities }),
      false,
    );
  }
});
