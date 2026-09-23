import { getProviderConnections, getProviderConnectionById, validateApiKey, updateProviderConnection, getSettings, getProxyPools } from "@/lib/localDb";
import { extractClientIp } from "@/sse/utils/clientIp";
import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, getModelLockUntil, buildModelLockUpdate, getEarliestModelLockUntil } from "open-sse/services/accountFallback.js";
import {
  MAX_RATE_LIMIT_COOLDOWN_MS,
  DEFAULT_ACCOUNT_COOLDOWN_MIN_MS,
  DEFAULT_ACCOUNT_COOLDOWN_MAX_MS,
} from "open-sse/config/errorConfig.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { getAntigravityQuotaCache } from "./antigravityQuota.js";
import { getConcurrencySnapshot, pauseAccountQueue, waitForAccountRequest } from "./concurrencyLimiter.js";
import * as log from "../utils/logger.js";
import { clearSessionBinding, getSessionBinding, bindSession } from "./sessionRouting.js";

// Share selection state across route bundles and development reloads.
const selectionState = globalThis.__ninerouterAccountSelection ||= {
  mutex: Promise.resolve(), cursors: new Map(), reservations: new Map(),
};
const selectionCursors = selectionState.cursors;
const selectionReservations = selectionState.reservations;

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

function preferConnectionsWithCapacity(connections) {
  if (connections.length < 2) return connections;

  const loads = new Map(
    getConcurrencySnapshot()
      .filter((item) => item.scope === "account")
      .map((item) => [item.id, item])
  );
  const getLoad = (connection) => {
    const limit = Number(connection.maxConcurrency) || 0;
    const pool = loads.get(connection.id);
    const active = (pool?.active || 0) + (selectionReservations.get(connection.id) || 0);
    const queued = pool?.queued || 0;
    return { limit, active, queued };
  };

  // Prefer accounts that can start immediately. This prevents fill-first from
  // sending every request to the first account while another account is idle.
  const ready = connections.filter((connection) => {
    const { limit, active, queued } = getLoad(connection);
    return limit === 0 || (active < limit && queued === 0);
  });
  if (ready.length > 0) return ready;

  // If every account is busy, prefer the least-loaded account so new waiters
  // do not keep piling onto the first account's queue.
  return [...connections].sort((a, b) => {
    const left = getLoad(a);
    const right = getLoad(b);
    const leftQueued = left.queued;
    const rightQueued = right.queued;
    if (leftQueued !== rightQueued) return leftQueued - rightQueued;
    if (left.limit === 0 || right.limit === 0) return left.limit === 0 ? -1 : 1;
    return (left.active / left.limit) - (right.active / right.limit);
  });
}

function pickNextConnection(connections, providerId) {
  if (connections.length === 0) return null;
  const cursor = selectionCursors.get(providerId) || 0;
  const connection = connections[cursor % connections.length];
  selectionCursors.set(providerId, (cursor + 1) % connections.length);
  return connection;
}

function githubMonthlyResetMs(status, errorText, provider) {
  if (resolveProviderId(provider) !== "github" || Number(status) !== 402) return null;
  if (!String(errorText || "").toLowerCase().includes(GITHUB_MONTHLY_USAGE_LIMIT)) return null;
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  const modelFor = (connection) => options.modelByConnection?.[connection?.id] || model;
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionState.mutex;
  let resolveMutex;
  selectionState.mutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);
    const sessionKey = options.sessionKey;
    let binding = await getSessionBinding(sessionKey);
    if (binding && binding.provider !== providerId) {
      return { sessionUnavailable: true, lastErrorCode: 409, lastError: "当前会话已绑定其他提供商，不能切换。" };
    }

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";
      let pickedId = override.proxyPoolId || null;
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        const poolIds = allPools.filter(p => p.proxyUrl).map(p => p.id);
        pickedId = pickProxyPoolId(poolIds, strategy, providerId);
      }
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" });
      if (sessionKey && !binding) await bindSession(sessionKey, providerId, "noauth");
      return {
        id: "noauth",
        connectionId: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        },
      };
    }

    const connections = await getProviderConnections({ provider: providerId, isActive: true });
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    // A deleted or replaced connection cannot serve the old sticky session.
    // Clear only this stale binding so the current request can select and bind
    // a new account. Existing connections that are merely locked still follow
    // the cooldown path below and never fail over automatically.
    const boundConnection = binding ? await getProviderConnectionById(binding.connectionId) : null;
    if (binding && !boundConnection) {
      await clearSessionBinding(sessionKey);
      log.info("AUTH", `${provider} | cleared stale session binding ${binding.connectionId?.slice(0, 8) || "unknown"}`);
      binding = null;
    }

    if (connections.length === 0) {
      if (binding) return { sessionUnavailable: true, lastErrorCode: 503, lastError: "当前会话绑定的账号已停用或删除。" };
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // Antigravity quota cache is lazy: only populated after that account returns 409/429.
    const isAntigravity = providerId === "antigravity";
    const antigravityQuotaCache = isAntigravity && model ? getAntigravityQuotaCache() : null;

    // Filter out model-locked, excluded, and Antigravity quota-exhausted connections.
    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, modelFor(c)) && !(options.waitForCooldown && binding?.connectionId === c.id && Number(c.errorCode) === 503)) return false;
      // Antigravity: skip if live quota exhausted for this model
      if (isAntigravity && model && antigravityQuotaCache) {
        const quota = antigravityQuotaCache.get(c.id)?.[modelFor(c)];
        if (quota && quota.remainingPercentage <= 0 && quota.resetAt && new Date(quota.resetAt).getTime() > Date.now()) {
          const account = c.id?.slice(0, 8) || "unknown";
          log.info("AG_QUOTA", `${account} | CACHE_BLOCK ${modelFor(c)} — skip upstream until ${quota.resetAt}`);
          return false;
        }
      }
      return true;
    });

    const capacityConnections = preferConnectionsWithCapacity(availableConnections);
    if (binding && !availableConnections.some((item) => item.id === binding.connectionId)) {
      const bound = connections.find((item) => item.id === binding.connectionId);
      return { sessionUnavailable: true, lastErrorCode: Number(bound?.errorCode) || 503, lastError: bound?.lastError || "当前会话绑定的账号暂不可用。", retryAfter: getModelLockUntil(bound, modelFor(bound)) };
    }

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length} | capacity-ready: ${capacityConnections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, modelFor(c));
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${modelFor(c)}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest persistent lock or lazy Antigravity quota-cache reset for retry timing.
      const lockedConns = connections.filter(c => isModelLockActive(c, modelFor(c)));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      if (isAntigravity && model && antigravityQuotaCache) {
        connections.forEach((c) => {
          const resetAt = antigravityQuotaCache.get(c.id)?.[modelFor(c)]?.resetAt;
          if (resetAt && new Date(resetAt).getTime() > Date.now()) expiries.push(resetAt);
        });
      }
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const settings = await getSettings();
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    let connection;
    if (sessionKey || options.fillFirst) {
      // Fill the first available account only once; a bound session ignores load.
      connection = binding
        ? availableConnections.find((item) => item.id === binding.connectionId)
        : capacityConnections[0];
    }
    // Pin to preferred connection if specified and available
    if (!connection && preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    if (!connection && strategy === "round-robin") {
      const hasConcurrencyLimits = capacityConnections.some((item) => Number(item.maxConcurrency) > 0);
      if (hasConcurrencyLimits) {
        // Concurrency-aware routing takes precedence over sticky rotation:
        // otherwise a high sticky limit can fill one account while peers idle.
        connection = pickNextConnection(capacityConnections, `${providerId}:capacity`);
      }
    }
    if (!connection && strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...capacityConnections].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...capacityConnections].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else if (!connection) {
      // Default: fill-first (already sorted by priority in getProviderConnections)
      connection = capacityConnections.some((item) => Number(item.maxConcurrency) > 0)
        ? pickNextConnection(capacityConnections, `${providerId}:capacity`)
        : capacityConnections[0];
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
    if (sessionKey && !binding) await bindSession(sessionKey, providerId, connection.id);
    let releaseSelection;
    if (sessionKey || options.fillFirst) {
      selectionReservations.set(connection.id, (selectionReservations.get(connection.id) || 0) + 1);
      let released = false;
      releaseSelection = () => {
        if (released) return;
        released = true;
        const remaining = (selectionReservations.get(connection.id) || 1) - 1;
        if (remaining) selectionReservations.set(connection.id, remaining);
        else selectionReservations.delete(connection.id);
      };
    }

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
      },
      connectionId: connection.id,
      releaseSelection,
      maxConcurrency: connection.maxConcurrency || 0,
      minRequestIntervalMs: Number(connection.minRequestIntervalMs) || 0,
      maxRequestIntervalMs: Number(connection.maxRequestIntervalMs) || Number(connection.minRequestIntervalMs) || 0,
      accountCooldownMinMs: Number(connection.accountCooldownMinMs) || DEFAULT_ACCOUNT_COOLDOWN_MIN_MS,
      accountCooldownMaxMs: Number(connection.accountCooldownMaxMs) || DEFAULT_ACCOUNT_COOLDOWN_MAX_MS,
      beforeUpstreamRequest: ({ signal } = {}) => waitForAccountRequest({
        id: connection.id,
        minIntervalMs: Number(connection.minRequestIntervalMs) || 0,
        maxIntervalMs: Number(connection.maxRequestIntervalMs) || Number(connection.minRequestIntervalMs) || 0,
        signal,
      }),
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
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
    ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel));
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

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey, request) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey, extractClientIp(request));
}
