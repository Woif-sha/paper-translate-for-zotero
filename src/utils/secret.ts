import { getPrefJSON, setPref } from "./prefs";

export function getServiceSecret(serviceId: string): string {
  const value = getPrefJSON("secretObj")[serviceId];
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new Error(`Stored secret for ${serviceId} is not a string`);
  }
  return value;
}

export function setServiceSecret(serviceId: string, secret: string): void {
  const secrets = getPrefJSON("secretObj");
  secrets[serviceId] = secret.trim();
  setPref("secretObj", JSON.stringify(secrets));
}
