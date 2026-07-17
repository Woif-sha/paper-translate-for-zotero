export const DEFAULT_CODEX_API_URL =
  "https://chatgpt.com/backend-api/codex/responses";

const CODEX_REFRESH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

type IOUtilsLike = {
  read(path: string): Promise<Uint8Array | ArrayBuffer>;
  write(path: string, data: Uint8Array): Promise<unknown>;
};

type CodexAuthJson = {
  tokens?: {
    access_token?: unknown;
    refresh_token?: unknown;
  };
  last_refresh?: string;
  [key: string]: unknown;
};

type CodexAuthState = {
  authPath: string;
  accessToken: string;
  refreshToken: string;
  document: CodexAuthJson;
};

export type LegacyCodexResult = {
  text: string;
  usedWebSearch: boolean;
};

export type LegacyCodexRequest = {
  apiUrl: string;
  model: string;
  effort?: string;
  instructions: string;
  prompt: string;
  signal?: AbortSignal;
  onDelta?: (delta: string, accumulated: string) => void;
  webSearch?: boolean;
  requireWebSearch?: boolean;
};

export class CodexResponsesStreamParser {
  private buffer = "";
  private text = "";
  private completed = false;
  private usedWebSearch = false;

  constructor(
    private readonly onDelta?: (delta: string, accumulated: string) => void,
  ) {}

  feed(chunk: string): void {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary >= 0) {
      this.parseFrame(this.buffer.slice(0, boundary));
      this.buffer = this.buffer.slice(boundary + 2);
      boundary = this.buffer.indexOf("\n\n");
    }
  }

  finish(): LegacyCodexResult {
    if (this.buffer.trim()) this.parseFrame(this.buffer);
    this.buffer = "";
    if (!this.completed) {
      throw new Error("Codex legacy response ended without completion");
    }
    if (!this.text.trim()) {
      throw new Error("Codex legacy response contained no assistant text");
    }
    return { text: this.text, usedWebSearch: this.usedWebSearch };
  }

  private parseFrame(frame: string): void {
    const payload = frame
      .split("\n")
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
      throw new Error(`Invalid Codex legacy SSE JSON: ${String(error)}`);
    }
    if (event.error) {
      throw new Error(
        `Codex legacy endpoint error: ${JSON.stringify(event.error)}`,
      );
    }
    const item = event.item ?? event.output_item;
    if (item?.type === "web_search_call") this.usedWebSearch = true;
    if (event.type === "response.output_text.delta") {
      if (typeof event.delta !== "string") {
        throw new Error("Codex legacy output delta is not text");
      }
      this.appendText(event.delta);
      return;
    }
    if (event.type === "response.completed") {
      this.completed = true;
      if (!this.text) {
        const completedText = extractResponseText(event.response);
        if (completedText) this.appendText(completedText);
      }
      return;
    }
    if (
      event.type === "response.failed" ||
      event.type === "response.incomplete"
    ) {
      throw new Error(`Codex legacy response ended with ${event.type}`);
    }
  }

  private appendText(delta: string): void {
    this.text += delta;
    this.onDelta?.(delta, this.text);
  }
}

export async function runLegacyCodexRequest(
  params: LegacyCodexRequest,
): Promise<LegacyCodexResult> {
  validateRequest(params);
  let auth = await loadCodexAuth();
  let response = await postCodexRequest(params, auth.accessToken);
  if (response.status === 401) {
    auth = await refreshCodexAccessToken(auth, params.signal);
    response = await postCodexRequest(params, auth.accessToken);
  }
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Codex legacy request failed: ${response.status} ${response.statusText} (${params.apiUrl}) - ${detail}`,
    );
  }
  if (!response.body) {
    throw new Error("Codex legacy response has no streaming body");
  }
  const parser = new CodexResponsesStreamParser(params.onDelta);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.feed(decoder.decode(value, { stream: true }));
  }
  parser.feed(decoder.decode());
  const result = parser.finish();
  if (params.requireWebSearch && !result.usedWebSearch) {
    throw new Error(
      "Codex background research completed without using web search",
    );
  }
  return result;
}

export async function testLegacyCodexConnection(params: {
  apiUrl: string;
  model: string;
  effort?: string;
}): Promise<string> {
  const result = await runLegacyCodexRequest({
    ...params,
    instructions: "Reply with exactly OK.",
    prompt: "Say OK",
  });
  return result.text.trim();
}

export function buildLegacyCodexPayload(
  params: Pick<
    LegacyCodexRequest,
    "model" | "effort" | "instructions" | "prompt" | "webSearch"
  >,
): Record<string, unknown> {
  const effort = normalizeEffort(params.effort);
  return {
    model: params.model.trim(),
    instructions: params.instructions,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: params.prompt }],
      },
    ],
    store: false,
    stream: true,
    ...(effort ? { reasoning: { effort } } : {}),
    ...(params.webSearch
      ? { tools: [{ type: "web_search" }], tool_choice: "auto" }
      : {}),
  };
}

export function normalizeEffort(value?: string): string | undefined {
  const effort = String(value || "").trim();
  return !effort || effort.toLowerCase() === "auto" ? undefined : effort;
}

function validateRequest(params: LegacyCodexRequest): void {
  const url = params.apiUrl.trim();
  if (!url) throw new Error("Codex API URL is required");
  if (url !== DEFAULT_CODEX_API_URL) {
    throw new Error(`Unsupported Codex legacy API URL: ${url}`);
  }
  if (!params.model.trim()) throw new Error("Codex model is required");
  if (!params.instructions.trim()) {
    throw new Error("Codex developer instructions are required");
  }
  if (!params.prompt.trim()) throw new Error("Codex prompt is required");
}

async function postCodexRequest(
  params: LegacyCodexRequest,
  accessToken: string,
): Promise<Response> {
  return getFetch()(params.apiUrl.trim(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(buildLegacyCodexPayload(params)),
    signal: params.signal,
  });
}

async function loadCodexAuth(): Promise<CodexAuthState> {
  const authPath = resolveCodexAuthPath();
  let raw: Uint8Array | ArrayBuffer;
  try {
    raw = await getIOUtils().read(authPath);
  } catch (error) {
    throw new Error(
      `Cannot read Codex auth file ${authPath}. Run codex login first: ${String(error)}`,
    );
  }
  let document: CodexAuthJson;
  try {
    document = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        raw instanceof Uint8Array ? raw : new Uint8Array(raw),
      ),
    ) as CodexAuthJson;
  } catch (error) {
    throw new Error(
      `Codex auth file is invalid: ${authPath}: ${String(error)}`,
    );
  }
  const accessToken = tokenValue(document.tokens?.access_token);
  const refreshToken = tokenValue(document.tokens?.refresh_token);
  if (!accessToken && !refreshToken) {
    throw new Error(`Codex auth tokens are missing: ${authPath}`);
  }
  if (!accessToken) {
    return refreshCodexAccessToken(
      { authPath, accessToken, refreshToken, document },
      undefined,
    );
  }
  return { authPath, accessToken, refreshToken, document };
}

async function refreshCodexAccessToken(
  auth: CodexAuthState,
  signal?: AbortSignal,
): Promise<CodexAuthState> {
  if (!auth.refreshToken) {
    throw new Error(
      `Codex refresh token is missing: ${auth.authPath}. Run codex login again.`,
    );
  }
  const response = await getFetch()(CODEX_REFRESH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: auth.refreshToken,
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `Codex token refresh failed: ${response.status} ${response.statusText} - ${await response.text()}`,
    );
  }
  const payload = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
  };
  const accessToken = tokenValue(payload.access_token);
  if (!accessToken) {
    throw new Error("Codex token refresh returned an empty access token");
  }
  const refreshToken = tokenValue(payload.refresh_token) || auth.refreshToken;
  const document: CodexAuthJson = {
    ...auth.document,
    tokens: {
      ...(auth.document.tokens || {}),
      access_token: accessToken,
      refresh_token: refreshToken,
    },
    last_refresh: new Date().toISOString(),
  };
  await getIOUtils().write(
    auth.authPath,
    new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`),
  );
  return { authPath: auth.authPath, accessToken, refreshToken, document };
}

function resolveCodexAuthPath(): string {
  const codexHome = Services.env.get("CODEX_HOME")?.trim();
  if (codexHome) return joinPath(codexHome, "auth.json");
  const interfaces = globalThis as unknown as {
    Ci?: { nsIFile?: unknown };
    Components?: { interfaces?: { nsIFile?: unknown } };
  };
  const nsIFile =
    interfaces.Ci?.nsIFile ?? interfaces.Components?.interfaces?.nsIFile;
  const homeDir = (
    Services.dirsvc.get("Home", nsIFile as any) as { path?: string }
  ).path?.trim();
  if (!homeDir)
    throw new Error("Unable to resolve home directory for Codex auth");
  return joinPath(homeDir, ".codex", "auth.json");
}

function getIOUtils(): IOUtilsLike {
  const io = (globalThis as unknown as { IOUtils?: IOUtilsLike }).IOUtils;
  if (!io?.read || !io?.write) {
    throw new Error("IOUtils is unavailable in this Zotero runtime");
  }
  return io;
}

function getFetch(): typeof fetch {
  const fetchFn = ztoolkit.getGlobal("fetch") as typeof fetch | undefined;
  if (!fetchFn) throw new Error("fetch is unavailable in this Zotero runtime");
  return fetchFn;
}

function tokenValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function joinPath(...parts: string[]): string {
  const separator = parts[0]?.includes("\\") ? "\\" : "/";
  return parts
    .map((part, index) =>
      index === 0
        ? part.replace(/[\\/]+$/, "")
        : part.replace(/^[\\/]+|[\\/]+$/g, ""),
    )
    .filter(Boolean)
    .join(separator);
}

function extractResponseText(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const value = response as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ type?: unknown; text?: unknown }> }>;
  };
  if (typeof value.output_text === "string") return value.output_text;
  return (value.output || [])
    .flatMap((item) => item.content || [])
    .filter(
      (part) =>
        (part.type === "output_text" || part.type === "text") &&
        typeof part.text === "string",
    )
    .map((part) => String(part.text))
    .join("");
}
