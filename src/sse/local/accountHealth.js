import { getProviderConnections, getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import { checkFallbackError, buildModelLockUpdate } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS, DEFAULT_ACCOUNT_COOLDOWN_MIN_MS, DEFAULT_ACCOUNT_COOLDOWN_MAX_MS } from "open-sse/config/errorConfig.js";
import { resolveProviderId } from "@/shared/constants/providers.js";
import { pauseAccountQueue } from "../services/concurrencyLimiter.js";
import * as log from "../utils/logger.js";

const GITHUB_MONTHLY_USAGE_LIMIT = "you've reached your additional usage limit for your plan";

function getAccountCooldownMs(connection) {
  const configuredMin = Number(connection?.accountCooldownMinMs);
  const configuredMax = Number(connection?.accountCooldownMaxMs);
  const min = Number.isFinite(configuredMin) && configuredMin >= 1000
    ? configuredMin
    : DEFAULT_ACCOUNT_COOLDOWN_MIN_MS;
  const max = Number.isFinite(configuredMax) && configuredMax >= 1000
    ? Math.max(min, configuredMax)
    : Math.max(min, DEFAULT_ACCOUNT_COOLDOWN_MAX_MS);
  return min + Math.floor(Math.random() * (max - min + 1));
}

function githubMonthlyResetMs(status, errorText, provider) {
  if (resolveProviderId(provider) !== "github" || Number(status) !== 402) return null;
  if (!String(errorText || "").toLowerCase().includes(GITHUB_MONTHLY_USAGE_LIMIT)) return null;
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

/**
 * Mark an account/model as unavailable. Overload and GitHub monthly quota
 * lock the whole account; other errors lock the affected model.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  // GitHub premium-request exhaustion is account-wide until the next UTC month.
  const githubResetAtMs = githubMonthlyResetMs(status, errorText, provider);

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel;
  if (githubResetAtMs) {
    shouldFallback = true;
    cooldownMs = githubResetAtMs - Date.now();
    newBackoffLevel = 0;
  } else if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    // Antigravity quota API provides exact per-model resetAt. Do not truncate it.
    cooldownMs = resolveProviderId(provider) === "antigravity"
      ? resetsAtMs - Date.now()
      : Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel, resolveProviderId(provider)));
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  // Keep provider reset times and 429 backoff untouched. Transient upstream
  // failures use the account's configured random cooldown range.
  if (!githubResetAtMs && !resetsAtMs && (status === 502 || status === 503 || /overloaded/i.test(String(errorText || "")))) {
    cooldownMs = getAccountCooldownMs(conn);
  }

  const reason = typeof errorText === "string" ? errorText.slice(0, 200) : "Provider error";
  const overloaded = status === 503 || /overloaded/i.test(reason);
  const lockUpdate = buildModelLockUpdate(githubResetAtMs || overloaded ? null : model, cooldownMs);

  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel
  });
  if (overloaded) pauseAccountQueue(connectionId, new Date(lockUpdate.modelLock___all).getTime());

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Clears expired locks, including the account-wide overload lock
 * - Preserves newer account cooldowns started by other in-flight requests
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  // Read current locks: another in-flight request may have started a cooldown.
  const conn = await getProviderConnectionById(connectionId)
    || currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, {
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0
    });
  }

  await updateProviderConnection(connectionId, clearObj, {
    resetHealthState: false,
    expectedModelLocks: Object.fromEntries(keysToClear.map(key => [key, conn[key]])),
  });
}
