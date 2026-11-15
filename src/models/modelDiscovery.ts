import type { ModelProviderGroup } from "./providers";
import {
  normalizeApiSettings,
  PROVIDER_PRESETS,
  resolveApiEndpoint,
} from "./protocols";
import { buildApiHeaders, redactError } from "./openAICompatibleClient";
import { withRequestDeadline } from "./requestLifetime";
import { modelCreationTime, sortDiscoveredModels } from "./modelCatalogSort";
import {
  DEFAULT_CODEX_API_URL,
  fetchLegacyCodexModels,
} from "../codex/legacyClient";

export type DiscoveredModel = {
  id: string;
  name: string;
  outputModalities?: string[];
  createdAt?: number;
};
const MAX_MODELS = 5000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 10;

/** API-key catalogs stay on the configured origin and never use Codex tokens. */
export function resolveModelCatalog(provider: ModelProviderGroup): {
  url: string;
  headers: Record<string, string>;
  paginated: boolean;
} {
  if (provider.authMode !== "openai_compatible") {
    throw new Error("API Key authentication is required for this catalog");
  }
  if (!provider.apiKey.trim())
    throw new Error("请先填写 API 密钥 / API key required");
  const settings = normalizeApiSettings(provider);
  const endpoint = new URL(
    resolveApiEndpoint(provider.apiBase, settings.protocol),
  );
  const preset = PROVIDER_PRESETS.find(
    (entry) => entry.id === settings.presetId && entry.url === endpoint.href,
  );
  let protocol = settings.protocol;
  if (preset?.id === "deepseek-anthropic") {
    endpoint.pathname = "/models";
    protocol = "chat_completions";
  } else {
    endpoint.pathname = endpoint.pathname.replace(
      /\/(?:chat\/completions|responses|messages)$/u,
      "/models",
    );
    if (preset?.id === "anthropic-chat") protocol = "anthropic_messages";
  }
  return {
    url: endpoint.href,
    headers: {
      ...buildApiHeaders({ ...settings, protocol, apiKey: provider.apiKey }),
      Accept: "application/json",
    },
    paginated: protocol === "anthropic_messages",
  };
}

export async function fetchProviderModels(
  provider: ModelProviderGroup,
  options: {
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<DiscoveredModel[]> {
  try {
    const catalog =
      provider.authMode === "codex_auth" ? null : resolveModelCatalog(provider);
    if (!catalog && provider.apiBase.trim() !== DEFAULT_CODEX_API_URL) {
      throw new Error("Unsupported Codex legacy API URL");
    }
    const fetchFn =
      options.fetchFn ?? (ztoolkit.getGlobal("fetch") as typeof fetch);
    if (!fetchFn) throw new Error("Global fetch is unavailable");
    return await withRequestDeadline(
      async (signal) => {
        if (!catalog) {
          const response = await fetchLegacyCodexModels({ signal, fetchFn });
          if (signal.aborted) throw signal.reason;
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error(
              `获取 Codex 模型列表失败（HTTP ${response.status}），请检查登录状态和权限，可继续手动添加 / Codex model listing failed; manual entry remains available`,
            );
          }
          const payload = await readCatalogResponse(response, { bytes: 0 });
          if (signal.aborted) throw signal.reason;
          return parseCodexCatalog(payload);
        }
        const models = new Map<string, DiscoveredModel>();
        const cursors = new Set<string>();
        const url = new URL(catalog.url);
        const budget = { bytes: 0 };
        for (let page = 0; page < MAX_PAGES; page += 1) {
          if (signal.aborted) throw signal.reason;
          const response = await fetchFn(url.href, {
            method: "GET",
            headers: catalog.headers,
            redirect: "error",
            signal,
          });
          if (signal.aborted) throw signal.reason;
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error(
              `获取模型失败（HTTP ${response.status}）。请检查密钥和权限；服务商可能未开放模型列表，可继续手动添加。 / Model listing failed; manual entry remains available`,
            );
          }
          const payload = await readCatalogResponse(response, budget);
          if (signal.aborted) throw signal.reason;
          if (!payload || !Array.isArray(payload.data)) {
            throw new Error(
              "模型列表格式无效（缺少 data 数组） / Invalid model list",
            );
          }
          for (const entry of payload.data) {
            const id = catalogModelId(entry?.id);
            const label = entry.display_name ?? entry.name;
            const createdAt = modelCreationTime(entry);
            if (!models.has(id)) {
              models.set(id, {
                id,
                name: typeof label === "string" ? label.slice(0, 160) : "",
                ...(createdAt === undefined ? {} : { createdAt }),
                ...(Array.isArray(entry.output_modalities) &&
                entry.output_modalities.length > 0 &&
                entry.output_modalities.length <= 16 &&
                entry.output_modalities.every(
                  (value: unknown) =>
                    typeof value === "string" &&
                    value.trim() &&
                    value.length <= 32,
                )
                  ? {
                      outputModalities: entry.output_modalities.map(
                        (value: string) => value.trim().toLowerCase(),
                      ),
                    }
                  : {}),
              });
            }
            if (models.size > MAX_MODELS) {
              throw new Error("模型数量超过上限 / Model list is too large");
            }
          }
          if (
            payload.has_more !== undefined &&
            typeof payload.has_more !== "boolean"
          ) {
            throw new Error("模型列表分页格式无效 / Invalid model pagination");
          }
          if (!payload.has_more) {
            if (!models.size)
              throw new Error(
                "服务商返回的模型列表为空，可手动添加 / Empty model list",
              );
            return sortDiscoveredModels([...models.values()]);
          }
          if (
            !catalog.paginated ||
            typeof payload.last_id !== "string" ||
            !payload.last_id ||
            cursors.has(payload.last_id) ||
            !payload.data.some(
              (entry: { id: string }) => entry.id === payload.last_id,
            )
          ) {
            throw new Error(
              "模型列表分页异常，请手动添加 / Invalid model pagination",
            );
          }
          cursors.add(payload.last_id);
          url.searchParams.set("after_id", payload.last_id);
        }
        throw new Error(
          "模型列表分页超过上限，请手动添加 / Too many model pages",
        );
      },
      Math.min(
        options.timeoutMs ?? 30_000,
        (provider.timeoutSeconds ?? 120) * 1000,
      ),
      options.signal,
    );
  } catch (error) {
    throw redactError(error, provider.apiKey);
  }
}

function catalogModelId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 256 ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new Error("模型列表包含无效 ID / Invalid model ID");
  }
  return value.trim();
}

function parseCodexCatalog(payload: unknown): DiscoveredModel[] {
  const record = payload as Record<string, unknown> | null;
  const entries = Array.isArray(record?.models)
    ? record.models
    : Array.isArray(record?.data)
      ? record.data
      : null;
  if (!entries) {
    throw new Error("Codex 模型列表格式无效 / Invalid Codex model list");
  }
  const models: Array<
    DiscoveredModel & { priority: number; serverOrder: number }
  > = [];
  const seen = new Set<string>();
  for (const [serverOrder, entry] of entries.entries()) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.visibility !== "string" ||
      entry.visibility.trim().toLowerCase() !== "list" ||
      typeof entry.slug !== "string" ||
      !entry.slug.trim()
    ) {
      continue;
    }
    const id = catalogModelId(entry.slug);
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const name =
      typeof entry.display_name === "string" ? entry.display_name.trim() : "";
    const priority = Number(entry.priority);
    models.push({
      id,
      name: name ? name.slice(0, 160) : id,
      priority: Number.isFinite(priority) ? priority : 0,
      serverOrder,
    });
    if (models.length > MAX_MODELS) {
      throw new Error("模型数量超过上限 / Model list is too large");
    }
  }
  if (!models.length) {
    throw new Error("Codex 返回的可选模型列表为空 / Empty Codex model list");
  }
  models.sort(
    (left, right) =>
      right.priority - left.priority || left.serverOrder - right.serverOrder,
  );
  return models.map(({ id, name }) => ({ id, name }));
}

async function readCatalogResponse(
  response: Response,
  budget: { bytes: number },
): Promise<any> {
  if (!response.body)
    throw new Error("模型列表响应为空 / Empty model response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      budget.bytes += value.byteLength;
      if (budget.bytes > MAX_BYTES) {
        throw new Error(
          "模型列表响应超过大小上限 / Model response is too large",
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("模型列表响应不是有效 JSON / Invalid model JSON");
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch (cancelError) {
      throw new AggregateError(
        [error, cancelError],
        "Model catalog reading and cancellation failed",
      );
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}
