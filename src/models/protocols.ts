export type ApiProtocol =
  | "chat_completions"
  | "responses"
  | "anthropic_messages";

export type ApiSettings = {
  protocol?: ApiProtocol;
  presetId?: string;
  anthropicVersion?: string;
  workspaceId?: string;
  maxTokens?: number;
  timeoutSeconds?: number;
};

export const API_PROTOCOLS: Array<[ApiProtocol, string]> = [
  ["responses", "Responses API"],
  ["chat_completions", "Chat Completions"],
  ["anthropic_messages", "Anthropic Messages"],
];

export const PROVIDER_PRESETS = [
  {
    id: "openai-responses",
    label: "OpenAI · Responses",
    protocol: "responses",
    url: "https://api.openai.com/v1/responses",
  },
  {
    id: "openai-chat",
    label: "OpenAI · Chat Completions",
    protocol: "chat_completions",
    url: "https://api.openai.com/v1/chat/completions",
  },
  {
    id: "anthropic-messages",
    label: "Anthropic · Messages",
    protocol: "anthropic_messages",
    url: "https://api.anthropic.com/v1/messages",
  },
  {
    id: "anthropic-chat",
    label: "Anthropic · Chat Completions（兼容）",
    protocol: "chat_completions",
    url: "https://api.anthropic.com/v1/chat/completions",
  },
  {
    id: "deepseek-chat",
    label: "DeepSeek · Chat Completions",
    protocol: "chat_completions",
    url: "https://api.deepseek.com/chat/completions",
  },
  {
    id: "deepseek-responses",
    label: "DeepSeek · Responses",
    protocol: "responses",
    url: "https://api.deepseek.com/responses",
  },
  {
    id: "deepseek-anthropic",
    label: "DeepSeek · Anthropic Compatible",
    protocol: "anthropic_messages",
    url: "https://api.deepseek.com/anthropic/v1/messages",
  },
] as const;

const SUFFIXES: Record<ApiProtocol, string> = {
  chat_completions: "/chat/completions",
  responses: "/responses",
  anthropic_messages: "/messages",
};

export function normalizeApiSettings(
  settings: ApiSettings,
): Required<ApiSettings> {
  const protocol = settings.protocol ?? "chat_completions";
  if (!API_PROTOCOLS.some(([id]) => id === protocol)) {
    throw new Error("Unknown API protocol / API 协议无效");
  }
  const presetId = settings.presetId || "custom";
  if (
    presetId !== "custom" &&
    !PROVIDER_PRESETS.some((entry) => entry.id === presetId)
  ) {
    throw new Error("Unknown provider preset / 服务商预设无效");
  }
  const timeoutSeconds = settings.timeoutSeconds ?? 120;
  const maxTokens = settings.maxTokens ?? 8192;
  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > 3600
  ) {
    throw new Error(
      "Request timeout must be 1–3600 seconds / 请求超时须为 1–3600 秒",
    );
  }
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 1_000_000) {
    throw new Error(
      "Output token limit must be a positive integer / 输出上限须为正整数",
    );
  }
  const anthropicVersion = (settings.anthropicVersion ?? "2023-06-01").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(anthropicVersion)) {
    throw new Error("Anthropic version must be YYYY-MM-DD");
  }
  const workspaceId = (settings.workspaceId ?? "").trim();
  if (/[\r\n]/u.test(workspaceId)) throw new Error("Invalid workspace ID");
  return {
    protocol,
    presetId,
    timeoutSeconds,
    maxTokens,
    anthropicVersion,
    workspaceId,
  };
}

/** Resolve only the explicitly selected protocol; never rewrite another endpoint. */
export function resolveApiEndpoint(
  apiBase: string,
  protocol: ApiProtocol,
): string {
  let url: URL;
  try {
    url = new URL(apiBase.trim());
  } catch {
    throw new Error("Invalid API address / API 地址无效");
  }
  if (url.protocol !== "https:") throw new Error("API address must use HTTPS");
  if (url.username || url.password || url.hash) {
    throw new Error("API address cannot contain credentials or a fragment");
  }
  if (
    Array.from(url.searchParams.keys()).some((key) =>
      /(?:api[-_]?key|token|secret|password|authorization)/iu.test(key),
    )
  ) {
    throw new Error(
      "Put credentials in the API key field, not the URL / 请在密钥栏填写凭据，不要放在 URL 中",
    );
  }
  let path = url.pathname.replace(/\/+$/u, "");
  const suffix = SUFFIXES[protocol];
  if (!suffix) throw new Error("Unknown API protocol");
  const present = Object.entries(SUFFIXES).find(([, value]) =>
    path.toLowerCase().endsWith(value),
  );
  if (present && present[0] !== protocol) {
    throw new Error(
      "API address conflicts with the selected protocol / 地址与所选协议不匹配，请修改地址或协议",
    );
  }
  if (!present) {
    if (!path) path = "/v1";
    if (
      protocol === "anthropic_messages" &&
      !/\/v\d+(?:beta)?(?:\/|$)/iu.test(path)
    )
      path += "/v1";
    path += suffix;
  }
  url.pathname = path;
  return url.href;
}

/** Query values can contain credentials and must never appear in the UI. */
export function endpointPreview(endpoint: string): string {
  const url = new URL(endpoint);
  return `${url.origin}${url.pathname}${url.search ? "?…" : ""}`;
}
