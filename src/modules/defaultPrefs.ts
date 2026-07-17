import { getPref, getPrefJSON, setPref } from "../utils/prefs";
import { services } from "./services";

export function setDefaultPrefSettings() {
  const servicesIds = services.getAllServices().map((service) => service.id);
  if (!servicesIds.includes((getPref("translateSource") as string) || "")) {
    setPref("translateSource", "paper-context");
  }

  if (!getPref("targetLanguage")) {
    setPref("targetLanguage", Zotero.locale);
  }

  const secrets = getPrefJSON("secretObj");
  for (const serviceId of servicesIds) {
    if (typeof secrets[serviceId] === "undefined") secrets[serviceId] = "";
  }
  setPref("secretObj", JSON.stringify(secrets));
}
