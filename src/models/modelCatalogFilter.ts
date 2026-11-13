import type { DiscoveredModel } from "./modelDiscovery";

// Display-only exclusions from the documented OpenAI catalog (2026-10-29).
// Unknown IDs remain visible; these rules never gate saving or model requests.
const SPECIALIST_IDS = new Set([
  "babbage-002",
  "davinci-002",
  "text-embedding-ada-002",
  "text-embedding-3-small",
  "text-embedding-3-large",
  "tts-1",
  "tts-1-hd",
  "whisper-1",
  "dall-e-2",
  "dall-e-3",
  "chatgpt-image-latest",
  "gpt-image-1",
  "gpt-image-1-mini",
  "gpt-image-1.5",
  "gpt-image-2",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-4o-audio-preview",
  "gpt-4o-mini-audio-preview",
  "gpt-4o-realtime-preview",
  "gpt-4o-mini-realtime-preview",
  "gpt-4o-transcribe",
  "gpt-4o-transcribe-diarize",
  "gpt-4o-mini-transcribe",
  "gpt-4o-mini-tts",
  "gpt-audio",
  "gpt-audio-mini",
  "gpt-audio-1.5",
  "gpt-realtime",
  "gpt-realtime-mini",
  "gpt-realtime-1.5",
  "gpt-realtime-2",
  "gpt-realtime-2.1",
  "gpt-realtime-2.1-mini",
  "gpt-realtime-translate",
  "gpt-realtime-whisper",
  "gpt-live-1",
  "gpt-live-transcribe",
  "gpt-transcribe",
  "omni-moderation",
  "omni-moderation-latest",
  "text-moderation",
  "text-moderation-latest",
  "text-moderation-stable",
  "text-moderation-007",
]);
const NON_TEXT_OUTPUTS = new Set([
  "audio",
  "image",
  "video",
  "embedding",
  "embeddings",
  "vector",
]);

/** A conservative picker default, not a claim that other models support translation. */
export function hideModelByDefault(model: DiscoveredModel): boolean {
  const id = model.id
    .trim()
    .toLowerCase()
    .replace(/^openai\//u, "");
  const base = id.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{4})$/u, "");
  if (SPECIALIST_IDS.has(id) || SPECIALIST_IDS.has(base)) return true;
  return (
    !!model.outputModalities?.length &&
    model.outputModalities.every((modality) => NON_TEXT_OUTPUTS.has(modality))
  );
}
