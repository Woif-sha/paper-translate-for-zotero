import { getPref, setPref } from "../utils/prefs";
import { DEFAULT_CODEX_API_URL } from "../codex/legacyClient";
import { PROVIDER_PRESETS } from "./protocols";
import type { ModelAuthMode, ModelProviderGroup } from "./providers";

export const PROVIDER_EDITOR_DRAFT_PREF = "paper.providerEditorDraft";
const CONNECTION_KEYS = [
  "apiBase",
  "apiKey",
  "protocol",
  "presetId",
  "workspaceId",
  "anthropicVersion",
  "maxTokens",
  "timeoutSeconds",
] as const;
type Connection = Pick<ModelProviderGroup, (typeof CONNECTION_KEYS)[number]>;
type Snapshot = {
  schemaVersion: 1;
  base: string;
  providers: ModelProviderGroup[];
  connections: [string, Connection][];
  efforts: [string, string][];
  openProviders: string[];
  openModels: string[];
  tab: number;
};

/** Partial editor state belongs only to Zotero preferences, never runtime settings. */
export class ProviderEditorDraft {
  providers: ModelProviderGroup[];
  openProviderIds = new Set<string>();
  openModelIds = new Set<string>();
  tab = 0;
  invalidCache = false;
  private base: string;
  private connections = new Map<string, Connection>();
  private efforts = new Map<string, string>();

  constructor(
    saved: ModelProviderGroup[],
    stored = String(getPref(PROVIDER_EDITOR_DRAFT_PREF) || ""),
  ) {
    this.base = JSON.stringify(saved);
    this.providers = clone(saved);
    if (!stored) return;
    try {
      const value: unknown = JSON.parse(stored);
      if (!isSnapshot(value)) throw new Error("Invalid editor draft");
      // Explicit changes to the saved providers take precedence over old drafts.
      if (value.base !== this.base) return;
      this.providers = value.providers;
      this.connections = new Map(value.connections);
      this.efforts = new Map(value.efforts);
      this.openProviderIds = new Set(value.openProviders);
      this.openModelIds = new Set(value.openModels);
      this.tab = value.tab;
    } catch {
      // Never include a malformed JSON fragment: it may contain a credential.
      this.invalidCache = true;
    }
  }

  remember(): void {
    for (const provider of this.providers) this.rememberConnection(provider);
    const providerIds = new Set(this.providers.map((provider) => provider.id));
    for (const key of this.connections.keys()) {
      if (!providerIds.has(JSON.parse(key)[0])) this.connections.delete(key);
    }
    for (const key of this.efforts.keys()) {
      if (!providerIds.has(JSON.parse(key)[0])) this.efforts.delete(key);
    }
    const snapshot: Snapshot = {
      schemaVersion: 1,
      base: this.base,
      providers: this.providers,
      connections: [...this.connections],
      efforts: [...this.efforts],
      openProviders: [...this.openProviderIds],
      openModels: [...this.openModelIds],
      tab: this.tab,
    };
    setPref(PROVIDER_EDITOR_DRAFT_PREF, JSON.stringify(snapshot));
  }

  acceptSaved(providers: ModelProviderGroup[]): void {
    this.base = JSON.stringify(providers);
    this.providers = clone(providers);
  }

  switchAuth(provider: ModelProviderGroup, next: ModelAuthMode): void {
    this.rememberConnection(provider);
    const previous = this.connections.get(slot(provider.id, `auth:${next}`));
    const fallback: Connection = {
      apiBase: next === "codex_auth" ? DEFAULT_CODEX_API_URL : "",
      apiKey: "",
      presetId: "custom",
      protocol: "chat_completions",
      workspaceId: "",
      anthropicVersion: "2023-06-01",
      maxTokens: 8192,
      timeoutSeconds: provider.timeoutSeconds ?? 120,
    };
    applyConnection(provider, previous ?? fallback);
    provider.authMode = next;
    if (next === "codex_auth") {
      provider.apiBase = DEFAULT_CODEX_API_URL;
      provider.apiKey = "";
    }
    for (const model of provider.models) {
      model.effort =
        next === "codex_auth"
          ? this.efforts.get(slot(provider.id, model.id)) || "medium"
          : "";
    }
  }

  switchPreset(provider: ModelProviderGroup, presetId: string): void {
    this.rememberConnection(provider);
    const selected = PROVIDER_PRESETS.find((entry) => entry.id === presetId);
    const previous = this.connections.get(
      slot(provider.id, `preset:${presetId}`),
    );
    if (previous && (!selected || previous.apiBase === selected.url)) {
      applyConnection(provider, previous);
    } else if (selected) {
      if (origin(provider.apiBase) !== origin(selected.url)) {
        provider.apiKey = "";
        provider.workspaceId = "";
      }
      provider.apiBase = selected.url;
      provider.protocol = selected.protocol;
    }
    provider.presetId = selected?.id || "custom";
  }

  private rememberConnection(provider: ModelProviderGroup): void {
    const connection = pickConnection(provider);
    this.connections.set(
      slot(provider.id, `auth:${provider.authMode}`),
      connection,
    );
    if (provider.authMode === "openai_compatible") {
      this.connections.set(
        slot(provider.id, `preset:${provider.presetId || "custom"}`),
        connection,
      );
    } else {
      for (const model of provider.models)
        this.efforts.set(slot(provider.id, model.id), model.effort);
    }
  }
}

function slot(providerId: string, field: string): string {
  return JSON.stringify([providerId, field]);
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}
function pickConnection(provider: ModelProviderGroup): Connection {
  return Object.fromEntries(
    CONNECTION_KEYS.map((key) => [key, provider[key]]),
  ) as Connection;
}
function applyConnection(
  provider: ModelProviderGroup,
  value: Connection,
): void {
  Object.assign(
    provider,
    Object.fromEntries(CONNECTION_KEYS.map((key) => [key, value[key]])),
  );
}

function isConnection(value: any): boolean {
  return (
    value &&
    typeof value === "object" &&
    typeof value.apiBase === "string" &&
    typeof value.apiKey === "string" &&
    ["protocol", "presetId", "workspaceId", "anthropicVersion"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    ) &&
    ["maxTokens", "timeoutSeconds"].every(
      (key) =>
        value[key] === undefined ||
        (typeof value[key] === "number" && Number.isFinite(value[key])),
    )
  );
}
function isSnapshot(value: any): value is Snapshot {
  const strings = (items: unknown) =>
    Array.isArray(items) && items.every((item) => typeof item === "string");
  const pairs = (items: unknown, check: (entry: any) => boolean) =>
    Array.isArray(items) &&
    items.every(
      (item) =>
        Array.isArray(item) &&
        item.length === 2 &&
        typeof item[0] === "string" &&
        validSlot(item[0]) &&
        check(item[1]),
    );
  return (
    value?.schemaVersion === 1 &&
    typeof value.base === "string" &&
    Array.isArray(value.providers) &&
    value.providers.every(
      (provider: any) =>
        isConnection(provider) &&
        typeof provider.id === "string" &&
        typeof provider.name === "string" &&
        ["codex_auth", "openai_compatible"].includes(provider.authMode) &&
        Array.isArray(provider.models) &&
        provider.models.every(
          (model: any) =>
            model &&
            ["id", "model", "effort"].every(
              (key) => typeof model[key] === "string",
            ),
        ),
    ) &&
    pairs(value.connections, isConnection) &&
    pairs(value.efforts, (entry) => typeof entry === "string") &&
    strings(value.openProviders) &&
    strings(value.openModels) &&
    (value.tab === 0 || value.tab === 1)
  );
}
function validSlot(value: string): boolean {
  try {
    const pair = JSON.parse(value);
    return (
      Array.isArray(pair) &&
      pair.length === 2 &&
      pair.every((entry) => typeof entry === "string")
    );
  } catch {
    return false;
  }
}
