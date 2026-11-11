import { createHash } from "node:crypto";
import kilocode, { KILO_MODELS_CONFIG } from "open-sse/providers/registry/kilocode.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

// Next.js bundles each route separately. Share the last catalog per connection
// across the dashboard, connection endpoint and OpenAI-compatible model list.
const cache = globalThis.__ninerouterKiloModels ||= new Map();

function parseModels(payload) {
  const models = new Map();
  for (const raw of Array.isArray(payload?.data) ? payload.data : []) {
    const id = typeof raw?.id === "string" ? raw.id.trim() : "";
    if (!id || models.has(id)) continue;

    const capabilities = {};
    if (Number.isFinite(raw.context_length) && raw.context_length > 0) capabilities.contextWindow = raw.context_length;
    const maxOutput = raw.top_provider?.max_completion_tokens ?? raw.max_completion_tokens;
    if (Number.isFinite(maxOutput) && maxOutput > 0) capabilities.maxOutput = maxOutput;
    if (Array.isArray(raw.architecture?.input_modalities)) {
      capabilities.vision = raw.architecture.input_modalities.includes("image");
    }
    if (Array.isArray(raw.supported_parameters)) {
      capabilities.tools = raw.supported_parameters.includes("tools");
      capabilities.reasoning = raw.supported_parameters.some(key =>
        ["reasoning", "reasoning_effort", "include_reasoning"].includes(key));
    }
    models.set(id, {
      id, name: typeof raw.name === "string" && raw.name.trim() ? raw.name : id,
      isFree: raw.isFree === true, capabilities,
    });
  }
  return [...models.values()];
}

async function fetchCatalog(entry, token, orgId, settings) {
  const failure = detail => {
    const message = `Failed to fetch Kilo Code models: ${detail}`;
    return entry.models
      ? { models: entry.models, cached: true, warning: `${message}. Showing the last successful list.` }
      : { models: [], error: message };
  };
  try {
    const apiBase = kilocode.oauth.apiBaseUrl;
    const url = orgId ? `${apiBase}/api/organizations/${encodeURIComponent(orgId)}/models`
      : token ? `${apiBase}/api/gateway/models` : KILO_MODELS_CONFIG.url;
    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (orgId) headers["X-KiloCode-OrganizationId"] = orgId;
    const proxy = settings ? await resolveConnectionProxyConfig(settings) : null;
    const response = await proxyAwareFetch(url, {
      headers, redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(KILO_MODELS_CONFIG.timeoutMs),
    }, proxy && { ...proxy, strictProxy: proxy.strictProxy || proxy.connectionProxyEnabled });
    if ([401, 403].includes(response.status)) entry.models = null;
    if (!response.ok) return failure(`HTTP ${response.status}`);
    const payload = await response.json();
    const models = parseModels(payload);
    // An organization allowlist can legitimately be empty.
    if (!models.length && !(orgId && Array.isArray(payload?.data) && payload.data.length === 0)) {
      return failure("empty catalog");
    }
    entry.models = models;
    entry.expiresAt = Date.now() + KILO_MODELS_CONFIG.cacheTtlMs;
    return { models, cached: false };
  } catch (error) {
    return failure(error.name === "TimeoutError" ? "request timed out" : "gateway unavailable");
  }
}

export async function resolveKiloModels(connection = null, { forceRefresh = false } = {}) {
  const token = connection?.accessToken || connection?.apiKey;
  const settings = connection?.providerSpecificData;
  const orgId = settings?.orgId;
  if (orgId && !token) return { models: [], error: "Kilo Code organization credentials are missing." };

  const key = connection?.id || "public";
  const scope = createHash("sha256").update(JSON.stringify([token, settings])).digest("hex");
  let entry = cache.get(key);
  if (!entry || entry.scope !== scope) {
    entry = { scope, models: null, expiresAt: 0, pending: null };
    cache.set(key, entry);
  }
  if (entry.pending) return entry.pending;
  if (!forceRefresh && entry.models && Date.now() < entry.expiresAt) {
    return { models: entry.models, cached: true };
  }
  entry.pending = fetchCatalog(entry, token, orgId, settings).finally(() => { entry.pending = null; });
  return entry.pending;
}

export async function resolveKiloCatalog(connections, { forceRefresh = false, respectEnabledModels = false } = {}) {
  const results = await Promise.all(connections.map(conn => resolveKiloModels(conn, { forceRefresh })));
  const models = new Map();
  const warnings = [];
  for (const [i, result] of results.entries()) {
    const conn = connections[i];
    if (result.warning || result.error) warnings.push(`${conn.name || conn.id}: ${result.warning || result.error}`);
    const enabled = conn.providerSpecificData?.enabledModels;
    const allowed = respectEnabledModels && Array.isArray(enabled) && enabled.length ? new Set(enabled) : null;
    for (const model of result.models) {
      if (allowed && !allowed.has(model.id) && !allowed.has(`${kilocode.alias}/${model.id}`) &&
          !allowed.has(`${kilocode.id}/${model.id}`)) continue;
      if (!models.has(model.id)) models.set(model.id, model);
    }
  }
  return { models: [...models.values()], cached: results.every(result => result.cached),
    ...(warnings.length ? { warning: warnings.join("\n") } : {}) };
}
