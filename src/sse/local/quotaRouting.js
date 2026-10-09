import { loadConnectionUsage } from "@/lib/providerUsage.js";
import { getProviderConnectionById, updateProviderConnection, getSettings } from "@/lib/localDb";
import { getProviderModels } from "open-sse/config/providerModels.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { QUOTA_CACHE_TTL_MS, QUOTA_FETCH_TIMEOUT_MS, getCodexRoutingPolicy, usesQuotaRouting } from "./routingPolicy.js";

const quotaCache = globalThis.__ninerouterRoutingQuotaCache ||= new Map();

function quotaFamily(model) {
  return getProviderModels("cx").find(entry => entry.id === model)?.quotaFamily
    || (String(model).includes("spark") ? "spark" : "normal");
}

function quotaLockKey(model) {
  return `modelLock_codex-quota-${quotaFamily(model)}`;
}

export async function loadCodexQuotaSnapshot(connection, { force = false } = {}) {
  const previous = quotaCache.get(connection.id);
  if (previous?.pending) return previous.pending;
  if (!force && previous && Date.now() - previous.checkedAt < QUOTA_CACHE_TTL_MS) return previous.usage;
  const entry = { checkedAt: Date.now(), usage: null, pending: null };
  quotaCache.set(connection.id, entry);
  entry.pending = loadConnectionUsage(connection, { force, signal: AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS) })
    .then(usage => { entry.usage = usage?.quotas ? usage : null; return entry.usage; })
    .catch(() => null)
    .finally(() => { entry.checkedAt = Date.now(); entry.pending = null; });
  return entry.pending;
}

export async function loadRoutingQuotas(connections, policy) {
  if (!usesQuotaRouting(policy)) return new Map();
  const ids = new Set(connections.map(connection => connection.id));
  for (const id of quotaCache.keys()) if (!ids.has(id)) quotaCache.delete(id);
  // Network I/O happens before the account-selection mutex is acquired.
  return new Map(await Promise.all(connections.map(async connection => [connection.id, await loadCodexQuotaSnapshot(connection)])));
}

export function getAccountQuotaState(connection, model, usage, policy, now = Date.now()) {
  if (!usesQuotaRouting(policy)) return { exhausted: false, retryAt: null, usedPercent: null };
  const family = quotaFamily(model);
  const prefix = family === "normal" ? "" : `${family}_`;
  const windows = ["session", "weekly"].flatMap(name => {
    const quota = usage?.quotas?.[`${prefix}${name}`];
    if (!quota || quota.unlimited || !Number.isFinite(quota.used) || !Number.isFinite(quota.total) || quota.total <= 0) return [];
    const resetMs = new Date(quota.resetAt).getTime();
    if (Number.isFinite(resetMs) && resetMs <= now) return [];
    return [{ name, used: Math.max(0, Math.min(100, quota.used / quota.total * 100)), resetAt: quota.resetAt }];
  });
  const exhaustedWindows = windows.filter(window => window.used >= 100);
  const lockUntil = connection?.[quotaLockKey(model)];
  const locked = new Date(lockUntil).getTime() > now;
  const limitReached = family === "normal" ? usage?.limitReached : usage?.[`${family}LimitReached`];
  const hasWindowData = ["session", "weekly"].some(name => usage?.quotas?.[`${prefix}${name}`]);
  const selectedWindows = windows.filter(window => policy.quotaWindow === "any" || window.name === policy.quotaWindow);
  return {
    exhausted: locked || exhaustedWindows.length > 0 || (limitReached === true && (windows.length > 0 || !hasWindowData)),
    retryAt: [locked ? lockUntil : null, ...exhaustedWindows.map(window => window.resetAt)].filter(Boolean).sort().at(-1) || null,
    usedPercent: selectedWindows.length ? Math.max(...selectedWindows.map(window => window.used)) : null,
  };
}

export function resolveQuotaRoutingModel(connection, model, usage, policy, contextMarker = null, poolQuotaLow = false) {
  const requestedModel = getProviderModels("cx").find(entry => entry.id === model);
  if (!policy.quotaModelSwitch || !requestedModel || requestedModel.kind || quotaFamily(model) !== "normal") return model;
  const quota = getAccountQuotaState(connection, model, usage, { ...policy, quotaWindow: "session" });
  if (quota.exhausted || (!poolQuotaLow && (quota.usedPercent === null || quota.usedPercent < policy.quotaUsedPercent))) return model;
  const target = policy.quotaFallbackModel;
  const requested = contextMarker ? `${target}[${contextMarker}]` : target;
  const entry = getProviderModels("cx").find(item => item.id === requested);
  const enabled = connection.providerSpecificData?.enabledModels;
  if (!entry || entry.kind || entry.quotaFamily || (Array.isArray(enabled) && enabled.length && !enabled.includes(requested))) return model;
  return target;
}

export function isCodexQuotaError(provider, status, error) {
  if (provider !== "codex" || ![402, 403, 429].includes(Number(status))) return false;
  const text = typeof error === "string" ? error : JSON.stringify(error || {});
  // The upstream parser may retain only error.message, so recognize Codex's
  // quota wording as well as the structured error code. Ordinary rate-limit
  // messages (and Retry-After headers alone) do not establish exhaustion.
  return /usage_limit_reached|insufficient_quota|quota[_ ]exceeded|usage limit (?:has been )?(?:reached|exceeded)|(?:hit|reached|exceeded) your usage limit/i.test(text);
}

export async function markCodexQuotaUnavailable(connectionId, status, error, provider, model, resetsAtMs) {
  if (!isCodexQuotaError(provider, status, error)) return null;
  const policy = getCodexRoutingPolicy(await getSettings());
  if (!usesQuotaRouting(policy)) return null;
  const connection = await getProviderConnectionById(connectionId);
  if (!connection) return null;
  const until = Number(resetsAtMs) > Date.now() ? Number(resetsAtMs) : Date.now() + MAX_RATE_LIMIT_COOLDOWN_MS;
  const key = quotaLockKey(model);
  const existingUntil = new Date(connection[key]).getTime();
  const expiry = Math.max(until, Number.isFinite(existingUntil) ? existingUntil : 0);
  await updateProviderConnection(connectionId, {
    [key]: new Date(expiry).toISOString(), testStatus: "unavailable", errorCode: status,
    lastError: String(typeof error === "string" ? error : JSON.stringify(error)).slice(0, 200),
    lastErrorAt: new Date().toISOString(),
  });
  // An in-flight usage read predating this failure must not undo exhaustion.
  quotaCache.delete(connectionId);
  return { shouldFallback: true, cooldownMs: expiry - Date.now() };
}
