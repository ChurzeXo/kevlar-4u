export type NormalizedRiskLevel = "🔴" | "🟡" | "🟢";

export function normalizeRiskLevel(level: string | undefined | null): NormalizedRiskLevel {
  if (!level) return "🟢";
  const l = level.toLowerCase().trim();
  if (l === "high" || l === "🔴" || l === "red" || l === "高" || l === "高危") return "🔴";
  if (l === "medium" || l === "🟡" || l === "yellow" || l === "中" || l === "中危") return "🟡";
  return "🟢";
}
