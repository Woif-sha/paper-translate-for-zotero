import type {
  LegacyCodexImageInput,
  LegacyCodexResult,
} from "../codex/legacyClient";

export type OpenAICompatibleRequest = {
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

export class OpenAICompatibleStreamParser {
  private buffer = "";
  private text = "";
  private completed = false;

  constructor(
    private readonly onDelta?: (delta: string, accumulated: string) => void,
    private readonly limits: StreamLimits = {},
  ) {}

  get isComplete(): boolean {
    return this.completed;
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    let boundary = findSseFrameBoundary(this.buffer);
    while (boundary) {
      this.parseFrame(this.buffer.slice(0, boundary.index));
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      boundary = findSseFrameBoundary(this.buffer);
    }
  }

  finish(): LegacyCodexResult {
    if (this.buffer.trim()) this.parseFrame(this.buffer);
    this.buffer = "";
    if (!this.completed) {
      throw new Error(
        "OpenAI Compatible streaming response ended without [DONE]",
      );
    }
    if (!this.text.trim()) {
      throw new Error("OpenAI Compatible response contained no assistant text");
    }
    return {
      text: this.text,
      usedWebSearch: false,
      webSearchCalls: 0,
      citedUrls: [],
    };
  }

  private parseFrame(frame: string): void {
    const payload = frame
      .split(/\r\n|\r|\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!payload) return;
    if (payload === "[DONE]") {
      this.completed = true;
      return;
    }
    let event: Record<string, any>;
    try {
      event = JSON.parse(payload) as Record<string, any>;
    } catch (error) {
      throw new Error(`Invalid OpenAI Compatible SSE JSON: ${String(error)}`);
    }
    if (event.error) {
      throw new Error(
        `OpenAI Compatible endpoint error: ${JSON.stringify(event.error)}`,
      );
    }
    const delta = event.choices?.[0]?.delta?.content;
    if (delta === undefined || delta === null || delta === "") return;
    if (typeof delta !== "string") {
      throw new Error("OpenAI Compatible output delta is not text");
    }
    const next = this.text + delta;
    if (
      this.limits.maxOutputCharacters &&
      next.length > this.limits.maxOutputCharacters
    ) {
      throw new Error(
        `OpenAI Compatible visible output exceeded the ${this.limits.maxOutputCharacters}-character limit`,
      );
    }
    this.text = next;
    this.onDelta?.(delta, this.text);
  }
}

export function resolveChatCompletionsEndpoint(apiBase: string): string {
  const value = apiBase.trim().replace(/\/+$/u, "");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error(`OpenAI Compatible API Base is invalid: ${String(error)}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error("OpenAI Compatible API Base must use HTTPS");
  }
  if (/\/chat\/completions$/iu.test(parsed.pathname)) return value;
  return `${value}/chat/completions`;
}

export function buildOpenAICompatiblePayload(
  params: Pick<
    OpenAICompatibleRequest,
    "model" | "instructions" | "prompt" | "image"
  >,
): Record<string, unknown> {
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
  validateRequest(params);
  try {
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
      "OpenAI Compatible Chat Completions does not define web search",
    );
  }
  const response = await resolveFetch(params.fetchFn)(
    resolveChatCompletionsEndpoint(params.apiBase),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.apiKey.trim()}`,
      },
      body: JSON.stringify(buildOpenAICompatiblePayload(params)),
      signal: params.signal,
    },
  );
  if (!response.ok) {
    const detail = await readBoundedErrorResponse(response);
    throw new Error(
      `OpenAI Compatible request failed: ${response.status} ${response.statusText} - ${detail}`,
    );
  }
  if (!response.body) {
    throw new Error("OpenAI Compatible response has no streaming body");
  }
  const parser = new OpenAICompatibleStreamParser(params.onDelta, {
    maxOutputCharacters: params.maxOutputCharacters,
  });
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
  resolveChatCompletionsEndpoint(params.apiBase);
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

function redactError(error: unknown, secret: string): unknown {
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

function findSseFrameBoundary(
  value: string,
): { index: number; length: number } | null {
  for (let index = 0; index < value.length; index += 1) {
    const first = lineEndingLength(value, index);
    if (!first) continue;
    const second = lineEndingLength(value, index + first);
    if (second) return { index, length: first + second };
    index += first - 1;
  }
  return null;
}

function lineEndingLength(value: string, index: number): number {
  if (value[index] === "\n") return 1;
  if (value[index] !== "\r") return 0;
  return value[index + 1] === "\n" ? 2 : 1;
}
