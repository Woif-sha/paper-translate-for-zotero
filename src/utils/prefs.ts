import { config } from "../../package.json";

export { getPref, setPref, getPrefJSON };

type KeysWithStringValue<T> = {
  [K in keyof T]: T[K] extends string ? K : never;
}[keyof T];

type KeysWithNumberValue<T> = {
  [K in keyof T]: T[K] extends number ? K : never;
}[keyof T];

type KeysWithBooleanValue<T> = {
  [K in keyof T]: T[K] extends boolean ? K : never;
}[keyof T];

type _PluginPrefsMap = _ZoteroTypes.Prefs["PluginPrefsMap"];
export type PrefKeys = keyof _PluginPrefsMap;
export type PrefKeysWithStringValue = KeysWithStringValue<_PluginPrefsMap>;
export type PrefKeysWithNumberValue = KeysWithNumberValue<_PluginPrefsMap>;
export type PrefKeysWithBooleanValue = KeysWithBooleanValue<_PluginPrefsMap>;

function getPref<K extends keyof _PluginPrefsMap>(key: K): _PluginPrefsMap[K];
function getPref(key: string): string | number | boolean;
function getPref(key: string): string | number | boolean {
  return Zotero.Prefs.get(`${config.prefsPrefix}.${key}`, true) as any;
}

function setPref<K extends keyof _PluginPrefsMap>(
  key: K,
  value: _PluginPrefsMap[K],
): void;
function setPref(key: string, value: string | number | boolean): void;
function setPref(key: string, value: string | number | boolean) {
  return Zotero.Prefs.set(`${config.prefsPrefix}.${key}`, value, true);
}

function getPrefJSON(key: string) {
  const parsed = JSON.parse(String(getPref(key) || "{}"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Preference ${key} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}
