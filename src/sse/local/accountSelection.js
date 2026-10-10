import { getProviderConnections, getProviderConnectionById, updateProviderConnection, getSettings, getProxyPools } from "@/lib/localDb";
import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";
import { formatRetryAfter, isModelLockActive, getModelLockUntil, getEarliestModelLockUntil } from "open-sse/services/accountFallback.js";
import { DEFAULT_ACCOUNT_COOLDOWN_MIN_MS, DEFAULT_ACCOUNT_COOLDOWN_MAX_MS } from "open-sse/config/errorConfig.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { getAntigravityQuotaCache, getAntigravityModelQuota } from "../services/antigravityQuota.js";
import { getConcurrencySnapshot, waitForAccountRequest } from "../services/concurrencyLimiter.js";
import { clearSessionBinding, getSessionBinding, bindSession } from "../services/sessionRouting.js";
import * as log from "../utils/logger.js";
import { getCodexRoutingPolicy } from "./routingPolicy.js";
import { preferLeastLoadedAccounts, selectBalancedAccount } from "./accountBalancing.js";
import { loadRoutingQuotas, getAccountQuotaState, resolveQuotaRoutingModel } from "./quotaRouting.js";
import { isCodexPoolQuotaLow } from "./quotaModelSwitch.js";
import { getAccountOverloadWarnings } from "@/lib/db/repos/accountOverloadWarningsRepo.js";
import { getApiKeyBinding, bindApiKey, getApiKeyBindingCounts } from "./apiKeyRouting.js";

// Share selection state across route bundles and development reloads.
const selectionState = globalThis.__ninerouterAccountSelection ||= {
  mutex: Promise.resolve(), cursors: new Map(), reservations: new Map(),
};
const selectionCursors = selectionState.cursors;
const selectionReservations = selectionState.reservations;

function pickNextConnection(connections, providerId) {
  if (connections.length === 0) return null;
  const cursor = selectionCursors.get(providerId) || 0;
  const connection = connections[cursor % connections.length];
  selectionCursors.set(providerId, (cursor + 1) % connections.length);
  return connection;
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
  const providerId = resolveProviderId(provider);
  const routingSettings = providerId === "codex" ? await getSettings() : null;
  const codexPolicy = routingSettings ? getCodexRoutingPolicy(routingSettings) : null;
  const quotaConnections = codexPolicy ? await getProviderConnections({ provider: providerId, isActive: true }) : [];
  const routingQuotas = codexPolicy
    ? await loadRoutingQuotas(quotaConnections, codexPolicy)
    : new Map();
  const poolQuotaLow = codexPolicy ? isCodexPoolQuotaLow(quotaConnections, routingQuotas, codexPolicy) : false;
  const modelFor = (connection) => {
    const requested = options.modelByConnection?.[connection?.id] || model;
    return codexPolicy && options.allowQuotaModelSwitch !== false
      ? resolveQuotaRoutingModel(connection, requested, routingQuotas.get(connection?.id), codexPolicy, options.contextMarker, poolQuotaLow)
      : requested;
  };
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionState.mutex;
  let resolveMutex;
  selectionState.mutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const sessionKey = options.sessionKey;
    const sessionBinding = await getSessionBinding(sessionKey);
    if (sessionBinding && sessionBinding.provider !== providerId) {
      return { sessionUnavailable: true, lastErrorCode: 409, lastError: "当前会话已绑定其他提供商，不能切换。" };
    }
    const apiKeyKey = codexPolicy?.apiKeyAffinity ? options.apiKeyRoutingKey : null;
    let binding = apiKeyKey ? await getApiKeyBinding(apiKeyKey) : sessionBinding;
    const bindingSubject = apiKeyKey ? "当前 API Key" : "当前会话";

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
    const boundConnection = binding ? await getProviderConnectionById(binding.connectionId) : null;
    if (binding && !boundConnection) {
      if (!apiKeyKey) await clearSessionBinding(sessionKey);
      log.info("AUTH", `${provider} | cleared stale session binding ${binding.connectionId?.slice(0, 8) || "unknown"}`);
      binding = null;
    }
    // A manually disabled account cannot serve its sessions. Persist the new
    // binding only after a replacement passes the usual availability filters.
    if (binding && !boundConnection.isActive) binding = null;

    if (connections.length === 0) {
      if (binding) return { sessionUnavailable: true, lastErrorCode: 503, lastError: `${bindingSubject}绑定的账号已停用或删除。` };
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    const quotaStates = new Map(connections.map(connection => [connection.id,
      codexPolicy ? getAccountQuotaState(connection, modelFor(connection), routingQuotas.get(connection.id), codexPolicy) : null,
    ]));
    const coolingAccounts = new Map(getConcurrencySnapshot()
      .filter(pool => pool.scope === "account" && pool.cooldownRemainingMs > 0)
      .map(pool => [pool.id, new Date(Date.now() + pool.cooldownRemainingMs).toISOString()]));
    // Only explicit exclusions or configured quota failover may replace an
    // existing binding. Busy or cooling accounts keep their sessions.
    if (binding && (
      excludeSet.has(binding.connectionId)
      || ((apiKeyKey || codexPolicy?.quotaFailover) && quotaStates.get(binding.connectionId)?.exhausted)
    )) binding = null;

    // Antigravity quota cache is lazy: only populated after that account returns 409/429.
    const isAntigravity = providerId === "antigravity";
    const antigravityQuotaCache = isAntigravity && model ? getAntigravityQuotaCache() : null;

    // Filter out model-locked, excluded, and Antigravity quota-exhausted connections.
    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (coolingAccounts.has(c.id)) return false;
      if (quotaStates.get(c.id)?.exhausted) return false;
      if (isModelLockActive(c, modelFor(c))) return false;
      const enabled = c.providerSpecificData?.enabledModels;
      const requestedModel = options.requestedModel || (options.contextMarker
        ? `${modelFor(c)}[${options.contextMarker}]` : modelFor(c));
      if (providerId === "codex" && Array.isArray(enabled) && enabled.length && requestedModel && !enabled.includes(requestedModel)) return false;
      // Antigravity: skip if live quota exhausted for this model
      if (isAntigravity && model && antigravityQuotaCache) {
        const connQuotas = antigravityQuotaCache.get(c.id);
        const quota = getAntigravityModelQuota(connQuotas, modelFor(c)) || connQuotas?.[modelFor(c)];
        if (quota && quota.remainingPercentage <= 0 && quota.resetAt && new Date(quota.resetAt).getTime() > Date.now()) {
          const account = c.id?.slice(0, 8) || "unknown";
          log.info("AG_QUOTA", `${account} | CACHE_BLOCK ${modelFor(c)} — skip upstream until ${quota.resetAt}`);
          return false;
        }
      }
      return true;
    });

    // Balance current work before comparing overload history or quota. An idle
    // recovered account is preferable to piling more work onto a busy account.
    // Allocate lazily on the first request. Give each key its own available
    // account before sharing, then balance the number of bound keys.
    const keyCounts = apiKeyKey && !binding ? await getApiKeyBindingCounts(providerId) : null;
    const fewestKeys = keyCounts && availableConnections.length
      ? Math.min(...availableConnections.map(connection => keyCounts.get(connection.id) || 0)) : 0;
    const allocationConnections = keyCounts
      ? availableConnections.filter(connection => (keyCounts.get(connection.id) || 0) === fewestKeys)
      : availableConnections;
    const overloadWarnings = await getAccountOverloadWarnings();
    const leastLoaded = preferLeastLoadedAccounts(allocationConnections, getConcurrencySnapshot(), selectionReservations);
    const withoutOverloads = leastLoaded.filter(connection => !overloadWarnings[connection.id]);
    const capacityConnections = withoutOverloads.length ? withoutOverloads : leastLoaded;
    if (binding && !availableConnections.some((item) => item.id === binding.connectionId)) {
      const bound = connections.find((item) => item.id === binding.connectionId);
      const quota = quotaStates.get(binding.connectionId);
      if (quota?.exhausted) return { sessionUnavailable: true, lastErrorCode: 429, lastError: `${bindingSubject}绑定的账号额度已用尽。`, retryAfter: quota.retryAt };
      return { sessionUnavailable: true, lastErrorCode: Number(bound?.errorCode) || 503, lastError: bound?.lastError || `${bindingSubject}绑定的账号暂不可用。`, retryAfter: coolingAccounts.get(binding.connectionId) || getModelLockUntil(bound, modelFor(bound)) };
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
      const exhausted = [...quotaStates.values()].filter(quota => quota?.exhausted);
      if (exhausted.length) return {
        allRateLimited: true, lastErrorCode: 429, lastError: "可用账号额度已用尽。",
        retryAfter: exhausted.map(quota => quota.retryAt).filter(Boolean).sort()[0] || null,
      };
      // Find earliest persistent lock or lazy Antigravity quota-cache reset for retry timing.
      const lockedConns = connections.filter(c => isModelLockActive(c, modelFor(c)));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      expiries.push(...connections.map(c => coolingAccounts.get(c.id)).filter(Boolean));
      if (isAntigravity && model && antigravityQuotaCache) {
        connections.forEach((c) => {
          const connQuotas = antigravityQuotaCache.get(c.id);
          const resetAt = (getAntigravityModelQuota(connQuotas, modelFor(c)) || connQuotas?.[modelFor(c)])?.resetAt;
          if (resetAt && new Date(resetAt).getTime() > Date.now()) expiries.push(resetAt);
        });
      }
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0] || connections.find(c => coolingAccounts.has(c.id));
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

    const settings = routingSettings || await getSettings();
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    let connection;
    if (binding) connection = availableConnections.find((item) => item.id === binding.connectionId);
    // Preserve the existing selection path unless a local strategy is chosen.
    if (!connection && (!codexPolicy || codexPolicy.accountStrategy === "inherit") && (sessionKey || options.fillFirst)) {
      connection = capacityConnections[0];
    }
    // Pin to preferred connection if specified and available
    if (!connection && preferredConnectionId) {
      connection = allocationConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    if (!connection && codexPolicy && codexPolicy.accountStrategy !== "inherit") {
      connection = selectBalancedAccount(capacityConnections, codexPolicy.accountStrategy,
        getConcurrencySnapshot(), selectionReservations, selectionCursors, `${providerId}:local-routing`, quotaStates);
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
    if (apiKeyKey && !binding) await bindApiKey(apiKeyKey, providerId, connection.id, options.apiKeyRecordId);
    if (sessionKey && (apiKeyKey ? sessionBinding?.connectionId !== connection.id : !binding)) {
      await bindSession(sessionKey, providerId, connection.id);
    }
    let releaseSelection;
    if (apiKeyKey || sessionKey || options.fillFirst) {
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
      routingModel: modelFor(connection),
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
