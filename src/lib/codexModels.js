import { createHash } from "node:crypto";
import codex, { CODEX_MODELS_CONFIG } from "open-sse/providers/registry/codex.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/lib/providerUsage";

const cache = globalThis.__ninerouterCodexModels ||= new Map();
const unavailable = () => ({ models: [], warning: "无法获取此账号的 Codex 模型列表，请稍后刷新。" });

export function parseCodexModels(payload) {
  const entries = Array.isArray(payload) ? payload : payload?.models || payload?.data;
  if (!Array.isArray(entries)) return [];
  const seen = new Set();
  return entries.flatMap(raw => {
    const value = raw?.slug || raw?.id;
    const id = typeof value === "string" ? value.trim() : "";
    if (!id || seen.has(id) || raw.visibility === "hide" || raw.supported_in_api === false) return [];
    seen.add(id);
    const capabilities = { ...getCapabilitiesForModel("codex", id) };
    if (Number.isFinite(raw.context_window) && raw.context_window > 0) capabilities.contextWindow = raw.context_window;
    if (Number.isFinite(raw.max_output_tokens) && raw.max_output_tokens > 0) capabilities.maxOutput = raw.max_output_tokens;
    if (Array.isArray(raw.input_modalities)) capabilities.vision = raw.input_modalities.includes("image");
    const supportedEffortLevels = (Array.isArray(raw.supported_reasoning_levels) ? raw.supported_reasoning_levels : [])
      .map(level => typeof level === "string" ? level : level?.effort).filter(level => typeof level === "string");
    return [{ id, name: raw.display_name || raw.name || id, kind: "llm", capabilities, supportedEffortLevels }];
  });
}

function cacheKey(connection) {
  return createHash("sha256").update(JSON.stringify([
    connection.id, connection.accessToken, connection.providerSpecificData,
  ])).digest("hex");
}

export async function resolveCodexModels(connection, { forceRefresh = false, cachedOnly = false } = {}) {
  if (!connection.accessToken) return unavailable();
  const key = cacheKey(connection);
  const previous = cache.get(key);
  if (cachedOnly) return previous?.result || unavailable();
  if (previous?.pending) return previous.pending;
  if (previous && previous.expiresAt > Date.now() && !forceRefresh) return previous.result;
  for (const [id, entry] of cache) if (!entry.pending && entry.expiresAt <= Date.now()) cache.delete(id);
  const entry = { pending: null, result: null, expiresAt: 0 };
  cache.set(key, entry);
  entry.pending = (async () => {
    try {
      const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
      const proxyOptions = { ...proxy, signal: AbortSignal.timeout(CODEX_MODELS_CONFIG.timeoutMs) };
      let current = (await refreshAndUpdateCredentials(connection, false, proxyOptions)).connection;
      const request = () => {
        const data = current.providerSpecificData || {};
        const accountId = data.workspaceId || data.accountId || data.chatgptAccountId;
        return proxyAwareFetch(CODEX_MODELS_CONFIG.url, {
          method: "GET", cache: "no-store", redirect: "error",
          headers: {
            ...codex.transport.headers, Accept: "application/json",
            Authorization: `Bearer ${current.accessToken}`,
            ...(accountId ? { "ChatGPT-Account-ID": accountId } : {}),
          },
        }, proxyOptions);
      };
      let response = await request();
      if (response.status === 401 && current.refreshToken) {
        current = (await refreshAndUpdateCredentials(current, true, proxyOptions)).connection;
        response = await request();
      }
      if (!response.ok) return unavailable();
      const models = parseCodexModels(await response.json());
      return { models, ...(models.length ? {} : { warning: "此账号未返回可用的 Codex 模型。" }) };
    } catch { return unavailable(); }
  })().then(result => {
    entry.result = result;
    entry.expiresAt = Date.now() + (result.warning ? CODEX_MODELS_CONFIG.timeoutMs : CODEX_MODELS_CONFIG.cacheTtlMs);
    return result;
  }).finally(() => { entry.pending = null; });
  return entry.pending;
}

export async function resolveCodexCatalog(connections, { respectEnabledModels = false, ...options } = {}) {
  const accounts = await Promise.all(connections.filter(connection => connection.provider === "codex").map(async connection => {
    const result = await resolveCodexModels(connection, options);
    const enabled = connection.providerSpecificData?.enabledModels;
    const models = respectEnabledModels && Array.isArray(enabled) && enabled.length
      ? result.models.filter(model => enabled.some(id => [model.id, `cx/${model.id}`, `codex/${model.id}`].includes(id)))
      : result.models;
    return { connectionId: connection.id, models, ...(result.warning ? { warning: result.warning } : {}) };
  }));
  const models = new Map();
  for (const account of accounts) for (const model of account.models) {
    if (!models.has(model.id)) models.set(model.id, { ...model, connectionIds: [] });
    models.get(model.id).connectionIds.push(account.connectionId);
  }
  return { models: [...models.values()], accounts };
}
