import { getPref, setPref } from "../utils/prefs";
import { services } from "./services";

export function setDefaultPrefSettings() {
  const servicesIds = services.getAllServices().map((service) => service.id);
  if (!servicesIds.includes((getPref("translateSource") as string) || "")) {
    setPref("translateSource", "paper-context");
  }

  if (!getPref("targetLanguage")) {
    setPref("targetLanguage", Zotero.locale);
  }
}
