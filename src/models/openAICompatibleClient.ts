import { ApiStreamParser } from "./apiStreamParser";
import {
  normalizeApiSettings,
  resolveApiEndpoint,
  type ApiSettings,
} from "./protocols";
import type {
  LegacyCodexImageInput,
  LegacyCodexResult,
} from "../codex/legacyClient";

export type OpenAICompatibleRequest = ApiSettings & {
  apiBase: string;
  apiKey: string;
  model: string;
  instructions: string;
  prompt: string;
  image?: LegacyCodexImageInput;
  signal?: AbortSignal;
  onDelta?: (delta: string, accumulated: string) => void;
  webSearch?: boolean;
  requireWebSearch?: boolean;
  maxOutputCharacters?: number;
  maxResponseBytes?: number;
  fetchFn?: typeof fetch;
};

type StreamLimits = Pick<OpenAICompatibleRequest, "maxOutputCharacters">;

const ERROR_RESPONSE_MAX_BYTES = 64 * 1024;

export class OpenAICompatibleStreamParser extends ApiStreamParser {
  constructor(
    onDelta?: (delta: string, accumulated: string) => void,
    limits: StreamLimits = {},
  ) {
    super("chat_completions", onDelta, limits.maxOutputCharacters);
  }
}

export function resolveChatCompletionsEndpoint(apiBase: string): string {
  return resolveApiEndpoint(apiBase, "chat_completions");
}

export function buildOpenAICompatiblePayload(
  params: Pick<
    OpenAICompatibleRequest,
    "model" | "instructions" | "prompt" | "image" | "protocol" | "maxTokens"
  >,
): Record<string, unknown> {
  if (params.protocol === "responses") {
    return {
      model: params.model.trim(),
      instructions: params.instructions,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: params.prompt },
            ...(params.image
              ? [
                  {
                    type: "input_image",
                    image_url: params.image.dataUrl,
                    detail: params.image.detail,
                  },
                ]
              : []),
          ],
        },
      ],
      stream: true,
      store: false,
    };
  }
  if (params.protocol === "anthropic_messages") {
    const content: Record<string, unknown>[] = [
      { type: "text", text: params.prompt },
    ];
    if (params.image) {
      const match = /^data:([^;]+);base64,(.+)$/u.exec(params.image.dataUrl);
      if (!match) throw new Error("Invalid image data URL");
      content.push({
        type: "image",
        source: { type: "base64", media_type: match[1], data: match[2] },
      });
    }
    return {
      model: params.model.trim(),
      system: params.instructions,
      messages: [{ role: "user", content }],
      max_tokens: params.maxTokens ?? 8192,
      stream: true,
    };
  }
  const userContent = params.image
    ? [
        { type: "text", text: params.prompt },
        {
          type: "image_url",
          image_url: {
            url: params.image.dataUrl,
            detail: params.image.detail,
          },
        },
      ]
    : params.prompt;
  return {
    model: params.model.trim(),
    messages: [
      { role: "system", content: params.instructions },
      { role: "user", content: userContent },
    ],
    stream: true,
  };
}

export async function runOpenAICompatibleRequest(
  params: OpenAICompatibleRequest,
): Promise<LegacyCodexResult> {
  try {
    validateRequest(params);
    return await runValidatedRequest(params);
  } catch (error) {
    throw redactError(error, params.apiKey);
  }
}

async function runValidatedRequest(
  params: OpenAICompatibleRequest,
): Promise<LegacyCodexResult> {
  if (params.webSearch || params.requireWebSearch) {
    throw new Error(
      "OpenAI Compatible Chat Completions does not define web search; API-key web search is not implemented for the selected protocol / 当前 API 协议尚未实现联网检索",
    );
  }
  const response = await resolveFetch(params.fetchFn)(
    resolveApiEndpoint(params.apiBase, params.protocol ?? "chat_completions"),
    {
      method: "POST",
      redirect: "error",
      headers: buildApiHeaders(params),
      body: JSON.stringify(buildOpenAICompatiblePayload(params)),
      signal: params.signal,
    },
  );
  if (!response.ok) {
    const detail = await readBoundedErrorResponse(response);
    if (params.image && endpointRejectsImageInput(response.status, detail)) {
      throw new Error(
        `当前模型 ${params.model.trim()} 不支持图片输入，无法进行图片取词`,
      );
    }
    throw new Error(
      `OpenAI Compatible request failed: ${response.status} ${response.statusText} - ${detail}`,
    );
  }
  if (!response.body) {
    throw new Error("OpenAI Compatible response has no streaming body");
  }
  const parser = new ApiStreamParser(
    params.protocol ?? "chat_completions",
    params.onDelta,
    params.maxOutputCharacters,
  );
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let responseBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      responseBytes += value.byteLength;
      if (params.maxResponseBytes && responseBytes > params.maxResponseBytes) {
        throw new Error(
          `OpenAI Compatible streaming response exceeded the ${params.maxResponseBytes}-byte limit`,
        );
      }
      parser.feed(decoder.decode(value, { stream: true }));
      if (parser.isComplete) {
        await reader.cancel();
        break;
      }
    }
    parser.feed(decoder.decode());
  } catch (error) {
    try {
      await reader.cancel();
    } catch (cancelError) {
      throw new AggregateError(
        [error, cancelError],
        "OpenAI Compatible stream parsing and cancellation both failed",
      );
    }
    throw error;
  }
  return parser.finish();
}

export async function testOpenAICompatibleConnection(params: {
  apiBase: string;
  apiKey: string;
  model: string;
  signal?: AbortSignal;
}): Promise<string> {
  const result = await runOpenAICompatibleRequest({
    ...params,
    instructions: "Reply with exactly OK.",
    prompt: "Say OK",
    maxOutputCharacters: 128,
    maxResponseBytes: 64_000,
  });
  return result.text.trim();
}

function validateRequest(params: OpenAICompatibleRequest): void {
  normalizeApiSettings(params);
  resolveApiEndpoint(params.apiBase, params.protocol ?? "chat_completions");
  if (!params.apiKey.trim()) {
    throw new Error("OpenAI Compatible API Key is required");
  }
  if (!params.model.trim()) {
    throw new Error("OpenAI Compatible model is required");
  }
  if (!params.instructions.trim()) {
    throw new Error("OpenAI Compatible developer instructions are required");
  }
  if (!params.prompt.trim()) {
    throw new Error("OpenAI Compatible prompt is required");
  }
  if (params.image) validateImage(params.image);
  for (const [name, value] of [
    ["maxOutputCharacters", params.maxOutputCharacters],
    ["maxResponseBytes", params.maxResponseBytes],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
}

function validateImage(image: LegacyCodexImageInput): void {
  if (image.detail !== "high") {
    throw new Error("OpenAI Compatible image detail must be high");
  }
  const match =
    /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(
      image.dataUrl,
    );
  if (!match || match[2].length % 4 !== 0) {
    throw new Error(
      "OpenAI Compatible image must be a valid base64 PNG, JPEG, or WebP data URL",
    );
  }
}

function resolveFetch(fetchFn?: typeof fetch): typeof fetch {
  if (fetchFn) return fetchFn;
  const runtimeFetch = ztoolkit.getGlobal("fetch") as typeof fetch | undefined;
  if (!runtimeFetch) throw new Error("Global fetch is unavailable");
  return runtimeFetch;
}

async function readBoundedErrorResponse(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let responseBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      responseBytes += value.byteLength;
      if (responseBytes > ERROR_RESPONSE_MAX_BYTES) {
        throw new Error(
          `OpenAI Compatible error response exceeded the ${ERROR_RESPONSE_MAX_BYTES}-byte limit`,
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    try {
      await reader.cancel();
    } catch (cancelError) {
      throw new AggregateError(
        [error, cancelError],
        "OpenAI Compatible error response and cancellation both failed",
      );
    }
    throw error;
  }
}

function redactSecret(value: string, secret: string): string {
  const normalizedSecret = secret.trim();
  if (!normalizedSecret) return value;
  return value.split(normalizedSecret).join("[API KEY REDACTED]");
}

function endpointRejectsImageInput(status: number, detail: string): boolean {
  if (![400, 415, 422].includes(status)) return false;
  const normalized = detail.toLowerCase();
  const mentionsImageInput =
    /\bimage_url\b|image input|image content|multimodal input|vision input|image.*not supported/u.test(
      normalized,
    );
  const rejectsCapability =
    /unknown variant.{0,80}\bimage_url\b|\bimage_url\b.{0,80}(?:unsupported|not supported|does not support|expected [`'"]?text)|(?:image input|multimodal input|vision input).{0,80}(?:unsupported|not supported|does not support)|only supports? text|text[- ]only/u.test(
      normalized,
    );
  return mentionsImageInput && rejectsCapability;
}

export function redactError(error: unknown, secret: string): unknown {
  if (error instanceof AggregateError) {
    return new AggregateError(
      Array.from(error.errors, (entry) => redactError(entry, secret)),
      redactSecret(error.message, secret),
    );
  }
  if (error instanceof Error) {
    const message = redactSecret(error.message, secret);
    const cause =
      "cause" in error && error.cause !== undefined
        ? redactError(error.cause, secret)
        : undefined;
    if (message === error.message && cause === error.cause) return error;
    const sanitized = new Error(
      message,
      cause === undefined ? undefined : { cause },
    );
    sanitized.name = error.name;
    return sanitized;
  }
  return redactSecret(String(error), secret);
}

export function buildApiHeaders(
  params: Pick<
    OpenAICompatibleRequest,
    "apiKey" | "protocol" | "anthropicVersion" | "workspaceId"
  >,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (params.protocol === "anthropic_messages") {
    headers["x-api-key"] = params.apiKey.trim();
    headers["anthropic-version"] = params.anthropicVersion || "2023-06-01";
  } else headers.Authorization = `Bearer ${params.apiKey.trim()}`;
  if (params.workspaceId?.trim())
    headers["anthropic-workspace-id"] = params.workspaceId.trim();
  return headers;
}
