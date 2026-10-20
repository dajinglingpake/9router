import { createHash } from "node:crypto";
import codebuddy, { CODEBUDDY_MODELS_CONFIG } from "open-sse/providers/registry/codebuddy-cn.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { refreshCodebuddyToken } from "open-sse/services/tokenRefresh/providers.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { updateProviderCredentials } from "@/sse/services/tokenRefresh";

const catalogCache = new Map();
const fallback = () => ({
  models: [],
  warning: "Unable to refresh CodeBuddy models; showing the built-in list.",
});

export function parseCodebuddyModels(payload) {
  if (payload?.code !== 0 || !Array.isArray(payload.data?.models)) return [];
  const agents = payload.data?.agents;
  const agent = Array.isArray(agents)
    ? agents.find((item) => item?.name === CODEBUDDY_MODELS_CONFIG.agent)
    : null;
  if (!Array.isArray(agent?.models)) return [];

  // The metadata catalog also contains retired and image-only models.
  // Only the authenticated CLI agent's selectable IDs belong in this list.
  const catalog = new Map(payload.data.models
    .filter((model) => typeof model?.id === "string")
    .map((model) => [model.id, model]));
  return [...new Set(agent.models)]
    .filter((id) => typeof id === "string" && id.trim() && catalog.has(id))
    .map((id) => {
      const raw = catalog.get(id);
      const capabilities = {};
      for (const [source, target] of [
        ["supportsImages", "vision"],
        ["supportsReasoning", "reasoning"],
        ["supportsToolCall", "tools"],
      ]) {
        if (typeof raw[source] === "boolean") capabilities[target] = raw[source];
      }
      if (raw.onlyReasoning === true) capabilities.reasoning = true;
      if (Number.isFinite(raw.maxInputTokens) && raw.maxInputTokens > 0) {
        capabilities.contextWindow = raw.maxInputTokens;
      }
      if (Number.isFinite(raw.maxOutputTokens) && raw.maxOutputTokens > 0) {
        capabilities.maxOutput = raw.maxOutputTokens;
      }
      return {
        id,
        name: typeof raw.name === "string" && raw.name.trim() ? raw.name : id,
        capabilities,
        supportedEffortLevels: Array.isArray(raw.reasoning?.supportedEfforts)
          ? raw.reasoning.supportedEfforts.filter((level) => typeof level === "string")
          : [],
      };
    });
}

function cacheKey(connection, token) {
  // Credentials never appear in a cache key or client response.
  return createHash("sha256").update(JSON.stringify([
    connection.id, connection.authType, token, connection.providerSpecificData,
  ])).digest("hex");
}

export async function resolveCodebuddyModels(connection, { forceRefresh = false } = {}) {
  const isApiKey = connection.authType === "apikey";
  let token = isApiKey ? connection.apiKey : connection.accessToken;
  if (!token) return fallback();
  const now = Date.now();
  for (const [key, entry] of catalogCache) {
    if (entry.expiresAt <= now) catalogCache.delete(key);
  }
  const cached = catalogCache.get(cacheKey(connection, token));
  if (!forceRefresh && cached) return { models: cached.models };

  try {
    const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
    const request = () => proxyAwareFetch(CODEBUDDY_MODELS_CONFIG.url, {
      method: "GET",
      headers: {
        ...codebuddy.transport.headers,
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(isApiKey ? { "X-API-Key": token } : {}),
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(CODEBUDDY_MODELS_CONFIG.timeoutMs),
    }, proxy);

    let response = await request();
    if (!isApiKey && [401, 403].includes(response.status) && connection.refreshToken) {
      const refreshed = await refreshCodebuddyToken(connection.refreshToken);
      if (refreshed?.accessToken) {
        await updateProviderCredentials(connection.id, refreshed);
        Object.assign(connection, refreshed);
        token = refreshed.accessToken;
        response = await request();
      }
    }
    if (!response.ok) return fallback();
    const models = parseCodebuddyModels(await response.json());
    if (!models.length) return fallback();
    catalogCache.set(cacheKey(connection, token), {
      models,
      expiresAt: Date.now() + CODEBUDDY_MODELS_CONFIG.cacheTtlMs,
    });
    return { models };
  } catch {
    return fallback();
  }
}
