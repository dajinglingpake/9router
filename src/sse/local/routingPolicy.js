// Local Codex policy stays outside upstream settings defaults.
export const CODEX_ROUTING_DEFAULTS = Object.freeze({
  accountStrategy: "inherit",
  apiKeyAffinity: false,
  allowCredits: false,
  quotaFailover: false,
  quotaModelSwitch: false,
  quotaUsedPercent: 90,
  quotaFallbackModel: "gpt-6-luna",
  quotaWindow: "any",
});

export const QUOTA_CACHE_TTL_MS = 60_000;
export const QUOTA_FETCH_TIMEOUT_MS = 5_000;

export function usesQuotaRouting(policy) {
  // Both credits policies require snapshots, including with the inherited strategy.
  return typeof policy.allowCredits === "boolean" || policy.accountStrategy === "quota-priority" || policy.apiKeyAffinity || policy.quotaFailover || policy.quotaModelSwitch;
}

export function normalizeCodexRouting(input = {}, previous = CODEX_ROUTING_DEFAULTS) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("账号路由配置格式错误");
  const result = { ...CODEX_ROUTING_DEFAULTS, ...previous };
  for (const key of Object.keys(CODEX_ROUTING_DEFAULTS)) {
    if (Object.hasOwn(input, key)) result[key] = input[key];
  }
  if (!["inherit", "quota-priority", "least-loaded", "round-robin", "fill-first"].includes(result.accountStrategy)) throw new Error("账号分配策略无效");
  for (const key of ["apiKeyAffinity", "allowCredits", "quotaFailover", "quotaModelSwitch"]) {
    if (typeof result[key] !== "boolean") throw new Error("自动切换开关无效");
  }
  if (!Number.isFinite(result.quotaUsedPercent) || result.quotaUsedPercent < 1 || result.quotaUsedPercent > 99) throw new Error("已用额度阈值须为 1–99%");
  if (!["any", "session", "weekly"].includes(result.quotaWindow)) throw new Error("额度周期无效");
  if (typeof result.quotaFallbackModel !== "string" || !result.quotaFallbackModel.trim() || result.quotaFallbackModel.includes("/")) throw new Error("降级模型无效");
  result.quotaFallbackModel = result.quotaFallbackModel.trim();
  return result;
}

export function getCodexRoutingPolicy(settings) {
  try { return normalizeCodexRouting(settings?.localCodexRouting || {}); }
  catch { return { ...CODEX_ROUTING_DEFAULTS }; }
}
