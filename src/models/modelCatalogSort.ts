import type { DiscoveredModel } from "./modelDiscovery";

export function modelCreationTime(entry: {
  created?: unknown;
  created_at?: unknown;
}): number | undefined {
  const iso =
    typeof entry.created_at === "string" &&
    /^\d{4}-\d{2}-\d{2}(?:T|$)/u.test(entry.created_at)
      ? Date.parse(entry.created_at)
      : NaN;
  const value = Number.isFinite(iso)
    ? iso
    : typeof entry.created === "number"
      ? entry.created * 1000
      : NaN;
  return Number.isFinite(value) && value > 0 && value <= 8.64e15
    ? value
    : undefined;
}

/** API dates take priority. Missing dates use descending natural model versions. */
export function sortDiscoveredModels(
  models: DiscoveredModel[],
): DiscoveredModel[] {
  return [...models].sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      if (a.createdAt === undefined) return 1;
      if (b.createdAt === undefined) return -1;
      return b.createdAt - a.createdAt;
    }
    return b.id.localeCompare(a.id, "en", {
      numeric: true,
      sensitivity: "base",
    });
  });
}
