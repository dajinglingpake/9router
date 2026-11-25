import { createHash } from "node:crypto";
import gemini from "open-sse/providers/registry/gemini.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { getGeminiChatModels } from "@/shared/utils/geminiModels";
import { filterFreeModels } from "@/shared/utils/modelTests";
import { getProviderModelPreferences, orderModelsByTestResult } from "@/lib/modelTests";
import { getGeminiFreeTier, getGeminiPricing } from "@/lib/geminiPricing";

const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchPages(apiKey, proxy) {
  const url = new URL(gemini.transport.baseUrl);
  url.searchParams.set("pageSize", "1000");
  const signal = AbortSignal.timeout(10000);
  const models = new Map();
  const tokens = new Set();
  for (;;) {
    const response = await proxyAwareFetch(url.toString(), {
      headers: { Accept: "application/json", "x-goog-api-key": apiKey },
      cache: "no-store", redirect: "error", signal,
    }, { ...proxy, strictProxy: proxy.strictProxy || proxy.connectionProxyEnabled });
    if (!response.ok) return { models: [], status: response.status, error: `获取 Gemini 模型失败（HTTP ${response.status}）。` };
    const page = await response.json();
    for (const model of page.models || []) {
      if (typeof model?.name === "string" && model.name.startsWith("models/")) models.set(model.name, model);
    }
    if (!page.nextPageToken) return { models: [...models.values()] };
    if (tokens.has(page.nextPageToken)) throw new Error("Repeated Gemini page token");
    tokens.add(page.nextPageToken);
    url.searchParams.set("pageToken", page.nextPageToken);
  }
}

// Keep the original Google Model records for per-connection API consumers.
export async function resolveGeminiModels(connection, { forceRefresh = false } = {}) {
  if (!connection.apiKey) return { models: [], status: 401, error: "Gemini 连接缺少 API Key。" };
  const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
  const key = createHash("sha256").update(JSON.stringify([connection.id, connection.apiKey, proxy])).digest("hex");
  const now = Date.now();
  for (const [id, entry] of cache) if (entry.expiresAt <= now) cache.delete(id);
  const cached = cache.get(key);
  if (cached && (cached.pending || !forceRefresh)) return cached.result;

  const entry = { pending: true, expiresAt: Infinity };
  entry.result = fetchPages(connection.apiKey, proxy)
    .catch(() => ({ models: [], status: 502, error: "无法获取完整的 Gemini 模型列表，请重试。" }))
    .then(result => {
      entry.pending = false;
      entry.expiresAt = Date.now() + (result.error ? 10000 : CACHE_TTL_MS);
      return result;
    });
  cache.set(key, entry);
  return entry.result;
}

export async function resolveGeminiChatCatalog(connections, options) {
  const active = connections.filter(c => c.provider === "gemini" && c.isActive !== false);
  const results = await Promise.all(active.map(async connection => {
    const result = await resolveGeminiModels(connection, options);
    const enabled = connection.providerSpecificData?.enabledModels;
    if (!Array.isArray(enabled) || !enabled.length) return result;
    const allowed = new Set(enabled.map(id => String(id).replace(/^(?:gemini|models)\//, "")));
    return { ...result, models: result.models.filter(m => allowed.has(m.name.slice("models/".length))) };
  }));
  const errors = [...new Set(results.map(r => r.error).filter(Boolean))];
  const preferences = options?.visibleOnly ? await getProviderModelPreferences() : null;
  const freeOnly = options?.freeOnly === true || preferences?.get("gemini")?.freeOnly === true;
  let models = getGeminiChatModels(results.flatMap(r => r.models));
  if ((options?.includePricing || freeOnly) && models.length) {
    const prices = await getGeminiPricing(options.forceRefresh);
    if (!prices.size) errors.push("Google 官方定价暂不可用，仅显示近期项目配额已确认的免费层标记。");
    const snapshots = active.map(c => c.providerSpecificData?.geminiQuotaSnapshot);
    models = models.map(model => ({ ...model, ...getGeminiFreeTier(model.id, prices, snapshots) }));
  }
  models = filterFreeModels(models, freeOnly);
  if (preferences && models.length) {
    models = await orderModelsByTestResult(models, active, preferences, m => `gemini/${m.id}`);
  }
  return { models, freeOnly, ...(errors.length ? { warning: errors.join(" ") } : {}) };
}

// The registry also uses some chat IDs for transcription. A stale transcription
// entry must not put a retired chat model back into a mixed catalog.
export function withGeminiMediaModels(chatModels, freeOnly = false) {
  if (freeOnly) return chatModels;
  const chatIds = new Set([...gemini.models.filter(m => !m.kind || m.kind === "llm"), ...chatModels].map(m => m.id));
  return [...chatModels, ...gemini.models.filter(m => m.kind && !chatIds.has(m.id))];
}
