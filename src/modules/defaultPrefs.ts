import { getPref, setPref } from "../utils/prefs";
import { FIXED_TARGET_LANGUAGE } from "../constants";
import { DEFAULT_CODEX_API_URL } from "../codex/legacyClient";
import { services } from "./services";

export function setDefaultPrefSettings() {
  const servicesIds = services.getAllServices().map((service) => service.id);
  if (!servicesIds.includes((getPref("translateSource") as string) || "")) {
    setPref("translateSource", "paper-context");
  }

  setPref("targetLanguage", FIXED_TARGET_LANGUAGE);
  setPref("paper.codexApiUrl", DEFAULT_CODEX_API_URL);
}
