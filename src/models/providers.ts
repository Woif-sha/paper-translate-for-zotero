import { DEFAULT_CODEX_API_URL } from "../codex/legacyClient";
import { getPref, setPref } from "../utils/prefs";

export type ModelAuthMode = "codex_auth" | "openai_compatible";

export type ProviderModel = {
  id: string;
  model: string;
  effort: string;
};

export type ModelProviderGroup = {
  id: string;
  name: string;
  authMode: ModelAuthMode;
  apiBase: string;
  apiKey: string;
  models: ProviderModel[];
};

export type ModelProviderConfiguration = {
  schemaVersion: 2;
  providers: ModelProviderGroup[];
  activeModelId: string;
};

export type RuntimeModel = ProviderModel & {
  providerId: string;
  providerName: string;
  authMode: ModelAuthMode;
  apiBase: string;
  apiKey: string;
  label: string;
  active: boolean;
};

type LegacyModelConfiguration = {
  model: string;
  effort: string;
};

const PROVIDERS_PREF = "paper.modelProviders";
const ACTIVE_MODEL_PREF = "paper.activeModelId";
const MODEL_PROVIDER_SCHEMA_VERSION = 2;
const listeners = new Set<() => void>();

export function migrateLegacyModelConfiguration(
  legacy: LegacyModelConfiguration,
): ModelProviderConfiguration {
  const modelName = requiredValue(legacy.model, "Codex model");
  const modelId = `model-codex-${identifierPart(modelName)}`;
  return {
    schemaVersion: MODEL_PROVIDER_SCHEMA_VERSION,
    providers: [
      {
        id: "provider-codex",
        name: "服务商 A",
        authMode: "codex_auth",
        apiBase: DEFAULT_CODEX_API_URL,
        apiKey: "",
        models: [
          {
            id: modelId,
            model: modelName,
            effort: legacy.effort.trim() || "medium",
          },
        ],
      },
    ],
    activeModelId: modelId,
  };
}

export function createProviderGroup(
  authMode: ModelAuthMode,
): ModelProviderGroup {
  return {
    id: createId("provider"),
    name: "",
    authMode,
    apiBase: authMode === "codex_auth" ? DEFAULT_CODEX_API_URL : "",
    apiKey: "",
    models: [],
  };
}

export function createProviderModel(model = ""): ProviderModel {
  return {
    id: createId("model"),
    model: model.trim(),
    effort: "medium",
  };
}

export function validateProviderGroup(
  provider: ModelProviderGroup,
): ModelProviderGroup {
  const missing: string[] = [];
  if (!provider.name.trim()) missing.push("服务商名称");
  if (provider.authMode === "openai_compatible") {
    if (!provider.apiBase.trim()) missing.push("API Base");
    if (!provider.apiKey.trim()) missing.push("API Key");
  }
  const models = provider.models;
  if (!models.length || models.some((entry) => !entry.model.trim())) {
    missing.push("模型 ID");
  }
  if (missing.length) {
    throw new Error(`无法保存服务商，缺少：${missing.join("、")}`);
  }
  const modelIds = new Set<string>();
  for (const model of models) {
    if (modelIds.has(model.id)) {
      throw new Error(`服务商包含重复模型 ID：${model.id}`);
    }
    modelIds.add(model.id);
  }
  return {
    id: requiredValue(provider.id, "Provider ID"),
    name: provider.name.trim(),
    authMode: provider.authMode,
    apiBase:
      provider.authMode === "codex_auth"
        ? DEFAULT_CODEX_API_URL
        : normalizeApiBase(provider.apiBase),
    apiKey:
      provider.authMode === "openai_compatible" ? provider.apiKey.trim() : "",
    models: models.map((entry) => ({
      id: requiredValue(entry.id, "Model entry ID"),
      model: entry.model.trim(),
      effort:
        provider.authMode === "codex_auth"
          ? entry.effort.trim() || "medium"
          : "",
    })),
  };
}

export function validateProviderConfiguration(
  providers: ModelProviderGroup[],
  activeModelId: string,
): ModelProviderConfiguration {
  if (!providers.length) {
    throw new Error("至少需要一个模型服务商");
  }
  const normalized = providers.map(validateProviderGroup);
  const providerIds = new Set<string>();
  const modelIds = new Set<string>();
  for (const provider of normalized) {
    if (providerIds.has(provider.id)) {
      throw new Error(`存在重复服务商 ID：${provider.id}`);
    }
    providerIds.add(provider.id);
    for (const model of provider.models) {
      if (modelIds.has(model.id)) {
        throw new Error(`存在重复模型条目 ID：${model.id}`);
      }
      modelIds.add(model.id);
    }
  }
  if (!modelIds.has(activeModelId)) {
    throw new Error("必须显式选择一个已保存的当前模型");
  }
  return {
    schemaVersion: MODEL_PROVIDER_SCHEMA_VERSION,
    providers: normalized,
    activeModelId,
  };
}

export function flattenRuntimeModels(
  providers: ModelProviderGroup[],
  activeModelId: string,
): RuntimeModel[] {
  return providers.flatMap((provider) =>
    provider.models
      .filter((entry) => entry.model.trim())
      .map((entry) => ({
        ...entry,
        providerId: provider.id,
        providerName: provider.name,
        authMode: provider.authMode,
        apiBase: provider.apiBase,
        apiKey: provider.apiKey,
        label: `${provider.name} / ${entry.model}`,
        active: entry.id === activeModelId,
      })),
  );
}

export function resolveDraftRuntimeModel(
  provider: ModelProviderGroup,
  model: ProviderModel,
): RuntimeModel {
  const normalized = validateProviderGroup({
    ...provider,
    models: [model],
  });
  const normalizedModel = normalized.models[0];
  return {
    ...normalizedModel,
    providerId: normalized.id,
    providerName: normalized.name,
    authMode: normalized.authMode,
    apiBase: normalized.apiBase,
    apiKey: normalized.apiKey,
    label: `${normalized.name} / ${normalizedModel.model}`,
    active: false,
  };
}

export function getModelProviderConfiguration(): ModelProviderConfiguration {
  const stored = String(getPref(PROVIDERS_PREF) || "").trim();
  if (!stored) {
    const migrated = migrateLegacyModelConfiguration({
      model: String(getPref("paper.codexModel") || "gpt-5.4"),
      effort: String(getPref("paper.codexEffort") || "medium"),
    });
    persistConfiguration(migrated);
    return migrated;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch (error) {
    throw new Error(`模型服务商配置不是有效 JSON：${String(error)}`);
  }
  const storedConfiguration = parseStoredConfiguration(parsed);
  const storedActive = String(getPref(ACTIVE_MODEL_PREF) || "").trim();
  const configuration = validateProviderConfiguration(
    migrateStoredProviderNames(storedConfiguration),
    storedActive,
  );
  if (storedConfiguration.schemaVersion < MODEL_PROVIDER_SCHEMA_VERSION) {
    persistConfiguration(configuration);
  }
  return configuration;
}

export function setModelProviderConfiguration(
  providers: ModelProviderGroup[],
  activeModelId: string,
): ModelProviderConfiguration {
  const configuration = validateProviderConfiguration(providers, activeModelId);
  persistConfiguration(configuration);
  notifyListeners();
  return configuration;
}

export function setActiveModelId(activeModelId: string): RuntimeModel {
  const current = getModelProviderConfiguration();
  const selected = flattenRuntimeModels(current.providers, activeModelId).find(
    (entry) => entry.id === activeModelId,
  );
  if (!selected) {
    throw new Error(`当前模型不存在：${activeModelId}`);
  }
  setPref(ACTIVE_MODEL_PREF, activeModelId);
  notifyListeners();
  return selected;
}

export function getActiveRuntimeModel(): RuntimeModel {
  const configuration = getModelProviderConfiguration();
  const selected = flattenRuntimeModels(
    configuration.providers,
    configuration.activeModelId,
  ).find((entry) => entry.active);
  if (!selected) throw new Error("没有可用的当前模型");
  return selected;
}

export function subscribeModelConfiguration(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function persistConfiguration(configuration: ModelProviderConfiguration): void {
  setPref(
    PROVIDERS_PREF,
    JSON.stringify({
      schemaVersion: configuration.schemaVersion,
      providers: configuration.providers,
    }),
  );
  setPref(ACTIVE_MODEL_PREF, configuration.activeModelId);
}

function parseStoredConfiguration(value: unknown): {
  schemaVersion: 1 | 2;
  providers: ModelProviderGroup[];
} {
  if (!value || typeof value !== "object") {
    throw new Error("模型服务商配置必须是对象");
  }
  const stored = value as {
    schemaVersion?: unknown;
    providers?: unknown;
  };
  if (stored.schemaVersion !== 1 && stored.schemaVersion !== 2) {
    throw new Error(
      `不支持的模型服务商配置版本：${String(stored.schemaVersion)}`,
    );
  }
  if (!Array.isArray(stored.providers)) {
    throw new Error("模型服务商配置缺少 providers 数组");
  }
  const providers = stored.providers.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`模型服务商 ${index + 1} 不是对象`);
    }
    const raw = entry as Partial<ModelProviderGroup>;
    if (raw.authMode !== "codex_auth" && raw.authMode !== "openai_compatible") {
      throw new Error(`模型服务商 ${index + 1} 的认证方式无效`);
    }
    return validateProviderGroup({
      id: String(raw.id || ""),
      name: String(raw.name || ""),
      authMode: raw.authMode,
      apiBase: String(raw.apiBase || ""),
      apiKey: String(raw.apiKey || ""),
      models: Array.isArray(raw.models)
        ? raw.models.map((model) => ({
            id: String(model?.id || ""),
            model: String(model?.model || ""),
            effort: String(model?.effort || ""),
          }))
        : [],
    });
  });
  return {
    schemaVersion: stored.schemaVersion,
    providers,
  };
}

function migrateStoredProviderNames(configuration: {
  schemaVersion: 1 | 2;
  providers: ModelProviderGroup[];
}): ModelProviderGroup[] {
  if (configuration.schemaVersion !== 1) return configuration.providers;
  return configuration.providers.map((provider) =>
    provider.id === "provider-codex" && provider.name === "Codex"
      ? { ...provider, name: "服务商 A" }
      : provider,
  );
}

function normalizeApiBase(value: string): string {
  const normalized = value.trim().replace(/\/+$/u, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch (error) {
    throw new Error(`API Base 不是有效 URL：${String(error)}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error("API Base 必须使用 HTTPS");
  }
  return normalized;
}

function requiredValue(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} 不能为空`);
  return normalized;
}

function identifierPart(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "") || "model"
  );
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function notifyListeners(): void {
  for (const listener of [...listeners]) listener();
}
