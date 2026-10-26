import { createHash } from "node:crypto";
import { KIMI_MODELS_CONFIG } from "open-sse/providers/registry/kimi.js";
import { buildKimiHeaders } from "open-sse/config/appConstants.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/lib/providerUsage";

const catalogCache = new Map();
const fallback = (reason = "") => ({
  models: [],
  warning: `Unable to refresh Kimi models${reason ? ` (${reason})` : ""}; showing the built-in list.`,
});

export function parseKimiModels(payload) {
  if (!Array.isArray(payload?.data)) return [];
  const seen = new Set();
  return payload.data.flatMap(raw => {
    if (typeof raw?.id !== "string" || !raw.id.trim() || seen.has(raw.id)) return [];
    seen.add(raw.id);
    const capabilities = {};
    for (const [source, target] of [
      ["supports_image_in", "vision"], ["supports_video_in", "videoInput"], ["supports_reasoning", "reasoning"],
    ]) {
      if (typeof raw[source] === "boolean") capabilities[target] = raw[source];
    }
    if (raw.reasoning?.type === "only" || raw.supports_thinking_type === "only") {
      capabilities.reasoning = true;
      capabilities.thinkingCanDisable = false;
    }
    const context = raw.context_length ?? raw.limit?.context;
    if (Number.isFinite(context) && context > 0) capabilities.contextWindow = context;
    const efforts = raw.reasoning?.effort?.valid ?? raw.think_efforts?.valid_efforts;
    return [{
      id: raw.id, name: typeof raw.display_name === "string" && raw.display_name.trim() ? raw.display_name : raw.id,
      kind: "llm", capabilities,
      supportedEffortLevels: Array.isArray(efforts)
        ? [...new Set(efforts.filter(level => typeof level === "string" && level.trim()))] : [],
    }];
  });
}

function cacheKey(connection) {
  // Scope catalogs to the account, authentication method and selected proxy.
  return createHash("sha256").update(JSON.stringify([
    connection.id, connection.authType, connection.accessToken, connection.apiKey, connection.providerSpecificData,
  ])).digest("hex");
}

export async function resolveKimiModels(connection, { forceRefresh = false } = {}) {
  const isApiKey = ["apikey", "api_key"].includes(connection.authType);
  if (!(isApiKey ? connection.apiKey : connection.accessToken)) return fallback("missing credentials");
  const now = Date.now();
  for (const [key, entry] of catalogCache) if (entry.expiresAt <= now) catalogCache.delete(key);
  const cached = catalogCache.get(cacheKey(connection));
  if (cached && !forceRefresh) return { models: cached.models };

  try {
    const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
    const proxyOptions = { ...proxy, strictProxy: proxy.connectionProxyEnabled === true || proxy.strictProxy === true,
      signal: AbortSignal.timeout(KIMI_MODELS_CONFIG.timeoutMs) };
    let current = isApiKey ? connection : (await refreshAndUpdateCredentials(connection, false, proxyOptions)).connection;
    const request = () => proxyAwareFetch(KIMI_MODELS_CONFIG.url, {
      method: "GET", cache: "no-store", redirect: "error", signal: proxyOptions.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${isApiKey ? current.apiKey : current.accessToken}`,
        ...(!isApiKey ? buildKimiHeaders(current.providerSpecificData?.deviceId) : {}),
      },
    }, proxyOptions);
    let response = await request();
    // A 403 is an entitlement failure, not a reason to rotate OAuth credentials.
    if (!isApiKey && response.status === 401 && current.refreshToken) {
      current = (await refreshAndUpdateCredentials(current, true, proxyOptions)).connection;
      response = await request();
    }
    if (!response.ok) return fallback(`HTTP ${response.status}`);
    const models = parseKimiModels(await response.json());
    if (!models.length) return fallback("empty catalog");
    catalogCache.set(cacheKey(current), { models, expiresAt: Date.now() + KIMI_MODELS_CONFIG.cacheTtlMs });
    return { models };
  } catch { return fallback(); }
}
