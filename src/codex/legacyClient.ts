export const DEFAULT_CODEX_API_URL =
  "https://chatgpt.com/backend-api/codex/responses";

const CODEX_REFRESH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_AUTH_REFRESH_TIMEOUT_MS = 30_000;

type IOUtilsLike = {
  read(path: string): Promise<Uint8Array | ArrayBuffer>;
  write(
    path: string,
    data: Uint8Array,
    options?: { tmpPath?: string },
  ): Promise<unknown>;
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
  webSearchCalls: number;
  citedUrls: string[];
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
  maxOutputTokens?: number;
  maxWebSearchCalls?: number;
};

type AuthRefreshJob = {
  promise: Promise<CodexAuthState>;
  controller: AbortController;
};

const authRefreshJobs = new Map<string, AuthRefreshJob>();

export class CodexResponsesStreamParser {
  private buffer = "";
  private text = "";
  private completed = false;
  private usedWebSearch = false;
  private readonly webSearchCallIDs = new Set<string>();
  private anonymousWebSearchCalls = 0;
  private readonly citedUrls = new Set<string>();

  constructor(
    private readonly onDelta?: (delta: string, accumulated: string) => void,
    private readonly maxWebSearchCalls?: number,
  ) {}

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
      throw new Error("Codex legacy response ended without completion");
    }
    if (!this.text.trim()) {
      throw new Error("Codex legacy response contained no assistant text");
    }
    return {
      text: this.text,
      usedWebSearch: this.usedWebSearch,
      webSearchCalls: this.webSearchCallIDs.size + this.anonymousWebSearchCalls,
      citedUrls: [...this.citedUrls],
    };
  }

  private parseFrame(frame: string): void {
    const payload = frame
      .split(/\r\n|\r|\n/)
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
    this.recordUrlCitations(event.annotation);
    this.recordUrlCitations(item);
    if (
      event.type === "response.output_item.added" &&
      item?.type === "web_search_call"
    ) {
      this.recordWebSearchCall(item);
    }
    if (event.type === "response.output_text.delta") {
      if (typeof event.delta !== "string") {
        throw new Error("Codex legacy output delta is not text");
      }
      this.appendText(event.delta);
      return;
    }
    if (event.type === "response.completed") {
      this.completed = true;
      this.recordUrlCitations(event.response);
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

  private recordWebSearchCall(item: Record<string, unknown>): void {
    this.usedWebSearch = true;
    const id = String(item.id || item.call_id || "").trim();
    if (id) this.webSearchCallIDs.add(id);
    else this.anonymousWebSearchCalls += 1;
    const count = this.webSearchCallIDs.size + this.anonymousWebSearchCalls;
    if (this.maxWebSearchCalls && count > this.maxWebSearchCalls) {
      throw new Error(
        `Codex web search exceeded the ${this.maxWebSearchCalls}-call limit`,
      );
    }
  }

  private recordUrlCitations(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) this.recordUrlCitations(item);
      return;
    }
    const item = value as Record<string, unknown>;
    if (item.type === "url_citation") {
      if (typeof item.url !== "string") {
        throw new Error("Codex URL citation has no URL");
      }
      let url: URL;
      try {
        url = new URL(item.url);
      } catch {
        throw new Error("Codex URL citation is invalid");
      }
      if (url.protocol !== "https:") {
        throw new Error("Codex URL citation must use HTTPS");
      }
      this.citedUrls.add(url.href);
    }
    for (const key of ["annotations", "content", "output"]) {
      this.recordUrlCitations(item[key]);
    }
  }
}

function findSseFrameBoundary(
  value: string,
): { index: number; length: number } | null {
  for (let index = 0; index < value.length; index += 1) {
    const first = sseLineEndingLength(value, index);
    if (!first) continue;
    const second = sseLineEndingLength(value, index + first);
    if (second) return { index, length: first + second };
    index += first - 1;
  }
  return null;
}

function sseLineEndingLength(value: string, index: number): number {
  if (value[index] === "\n") return 1;
  if (value[index] !== "\r") return 0;
  return value[index + 1] === "\n" ? 2 : 1;
}

export async function runLegacyCodexRequest(
  params: LegacyCodexRequest,
): Promise<LegacyCodexResult> {
  validateRequest(params);
  let auth = await loadCodexAuth(params.signal);
  let response = await postCodexRequest(params, auth.accessToken);
  if (response.status === 401) {
    await response.body?.cancel();
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
  const parser = new CodexResponsesStreamParser(
    params.onDelta,
    params.maxWebSearchCalls,
  );
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
    parser.feed(decoder.decode());
  } catch (error) {
    try {
      await reader.cancel();
    } catch (cancelError) {
      throw new AggregateError(
        [error, cancelError],
        "Codex stream parsing and cancellation both failed",
      );
    }
    throw error;
  }
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
  signal?: AbortSignal;
}): Promise<string> {
  const result = await runLegacyCodexRequest({
    apiUrl: params.apiUrl,
    model: params.model,
    signal: params.signal,
    instructions: "Reply with exactly OK.",
    prompt: "Say OK",
  });
  return result.text.trim();
}

export function buildLegacyCodexPayload(
  params: Pick<
    LegacyCodexRequest,
    | "model"
    | "effort"
    | "instructions"
    | "prompt"
    | "webSearch"
    | "maxOutputTokens"
    | "maxWebSearchCalls"
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
    ...(params.maxOutputTokens
      ? { max_output_tokens: params.maxOutputTokens }
      : {}),
    ...(params.maxWebSearchCalls
      ? { max_tool_calls: params.maxWebSearchCalls }
      : {}),
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
  for (const [name, value] of [
    ["maxOutputTokens", params.maxOutputTokens],
    ["maxWebSearchCalls", params.maxWebSearchCalls],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  if (params.maxWebSearchCalls !== undefined && !params.webSearch) {
    throw new Error("maxWebSearchCalls requires webSearch");
  }
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

async function loadCodexAuth(signal?: AbortSignal): Promise<CodexAuthState> {
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
      signal,
    );
  }
  return { authPath, accessToken, refreshToken, document };
}

async function refreshCodexAccessToken(
  auth: CodexAuthState,
  signal?: AbortSignal,
): Promise<CodexAuthState> {
  const active = authRefreshJobs.get(auth.authPath);
  if (active) return waitForSharedRefresh(active.promise, signal);
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(
          `Codex token refresh exceeded ${CODEX_AUTH_REFRESH_TIMEOUT_MS / 1_000} seconds`,
        ),
      ),
    CODEX_AUTH_REFRESH_TIMEOUT_MS,
  );
  const promise = refreshCodexAccessTokenNow(auth, controller.signal)
    .catch((error) => {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        throw reason instanceof Error
          ? reason
          : new Error("Codex token refresh was cancelled");
      }
      throw error;
    })
    .finally(() => {
      clearTimeout(timer);
      if (authRefreshJobs.get(auth.authPath)?.controller === controller) {
        authRefreshJobs.delete(auth.authPath);
      }
    });
  const job = { promise, controller };
  authRefreshJobs.set(auth.authPath, job);
  return waitForSharedRefresh(job.promise, signal);
}

export function cancelActiveCodexAuthRefreshes(): void {
  for (const [authPath, job] of [...authRefreshJobs]) {
    if (authRefreshJobs.get(authPath) === job) authRefreshJobs.delete(authPath);
    job.controller.abort(new Error("Codex token refresh was cancelled"));
  }
}

async function refreshCodexAccessTokenNow(
  auth: CodexAuthState,
  signal: AbortSignal,
): Promise<CodexAuthState> {
  const currentBeforeRequest = await readCodexAuthDocument(auth.authPath);
  assertSignalActive(signal);
  const currentAccessToken = tokenValue(
    currentBeforeRequest.tokens?.access_token,
  );
  const currentRefreshToken = tokenValue(
    currentBeforeRequest.tokens?.refresh_token,
  );
  if (
    currentAccessToken !== auth.accessToken ||
    currentRefreshToken !== auth.refreshToken
  ) {
    if (currentAccessToken && currentAccessToken !== auth.accessToken) {
      return {
        authPath: auth.authPath,
        accessToken: currentAccessToken,
        refreshToken: currentRefreshToken,
        document: currentBeforeRequest,
      };
    }
    throw new Error(
      "Codex auth changed during token refresh; run codex login again if needed.",
    );
  }
  const requestRefreshToken = currentRefreshToken;
  if (!requestRefreshToken) {
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
      refresh_token: requestRefreshToken,
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
  assertSignalActive(signal);
  const accessToken = tokenValue(payload.access_token);
  if (!accessToken) {
    throw new Error("Codex token refresh returned an empty access token");
  }
  const currentBeforeWrite = await readCodexAuthDocument(auth.authPath);
  assertSignalActive(signal);
  const currentAccessTokenBeforeWrite = tokenValue(
    currentBeforeWrite.tokens?.access_token,
  );
  const currentRefreshTokenBeforeWrite = tokenValue(
    currentBeforeWrite.tokens?.refresh_token,
  );
  if (
    currentAccessTokenBeforeWrite !== currentAccessToken ||
    currentRefreshTokenBeforeWrite !== requestRefreshToken
  ) {
    if (
      currentAccessTokenBeforeWrite &&
      currentAccessTokenBeforeWrite !== currentAccessToken
    ) {
      return {
        authPath: auth.authPath,
        accessToken: currentAccessTokenBeforeWrite,
        refreshToken: currentRefreshTokenBeforeWrite,
        document: currentBeforeWrite,
      };
    }
    throw new Error(
      "Codex auth changed during token refresh; refreshed credentials were not written.",
    );
  }
  const refreshToken =
    tokenValue(payload.refresh_token) ||
    tokenValue(currentBeforeWrite.tokens?.refresh_token) ||
    requestRefreshToken;
  const document: CodexAuthJson = {
    ...currentBeforeWrite,
    tokens: {
      ...(currentBeforeWrite.tokens || {}),
      access_token: accessToken,
      refresh_token: refreshToken,
    },
    last_refresh: new Date().toISOString(),
  };
  assertSignalActive(signal);
  await getIOUtils().write(
    auth.authPath,
    new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`),
    { tmpPath: `${auth.authPath}.paper-translate.tmp` },
  );
  return { authPath: auth.authPath, accessToken, refreshToken, document };
}

function assertSignalActive(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error("Codex request aborted");
}

function waitForSharedRefresh<T>(
  job: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return job;
  if (signal.aborted) return Promise.reject(new Error("Codex request aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Codex request aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    void job
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function readCodexAuthDocument(authPath: string): Promise<CodexAuthJson> {
  const raw = await getIOUtils().read(authPath);
  const value = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      raw instanceof Uint8Array ? raw : new Uint8Array(raw),
    ),
  ) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Codex auth file is invalid: ${authPath}`);
  }
  return value as CodexAuthJson;
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
