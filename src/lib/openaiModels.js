import { createHash } from "node:crypto";
import { OPENAI_MODELS_CONFIG } from "open-sse/providers/registry/openai.js";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

const catalogCache = new Map();
const knownModels = new Map(getModelsByProviderId("openai").map(model => [model.id, model]));
const fallback = (reason = "") => ({
  models: [],
  warning: `Unable to refresh OpenAI models${reason ? ` (${reason})` : ""}; showing the built-in list.`,
});

// The models endpoint lists every modality but does not label it. Keep existing
// metadata and classify model families so media models stay out of chat pickers.
function modelKind(id) {
  if (/embedding/.test(id)) return "embedding";
  if (/tts/.test(id)) return "tts";
  if (/transcribe|^whisper/.test(id)) return "stt";
  if (/^gpt-image|^chatgpt-image|^dall-e/.test(id)) return "image";
  if (/^sora/.test(id)) return "video";
  if (/moderation/.test(id)) return "moderation";
  if (/realtime|^gpt-live/.test(id)) return "realtime";
  if (/^babbage|^davinci|instruct/.test(id)) return "completion";
  return "llm";
}

export function parseOpenAIModels(payload) {
  if (!Array.isArray(payload?.data)) return [];
  const seen = new Set();
  return payload.data.flatMap(raw => {
    if (typeof raw?.id !== "string" || !raw.id.trim() || seen.has(raw.id)) return [];
    seen.add(raw.id);
    const known = knownModels.get(raw.id);
    return [{ ...known, id: raw.id, name: known?.name || raw.id, kind: known?.kind || modelKind(raw.id) }];
  });
}

export async function resolveOpenAIModels(connection, { forceRefresh = false } = {}) {
  if (!connection.apiKey) return fallback("missing credentials");
  try {
    const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
    const key = createHash("sha256").update(JSON.stringify([connection.id, connection.apiKey, proxy])).digest("hex");
    for (const [cacheKey, entry] of catalogCache) if (entry.expiresAt <= Date.now()) catalogCache.delete(cacheKey);
    if (!forceRefresh && catalogCache.has(key)) return { models: catalogCache.get(key).models };
    const signal = AbortSignal.timeout(OPENAI_MODELS_CONFIG.timeoutMs);
    const response = await proxyAwareFetch(OPENAI_MODELS_CONFIG.url, {
      method: "GET", cache: "no-store", redirect: "error", signal,
      headers: { Accept: "application/json", Authorization: `Bearer ${connection.apiKey}` },
    }, { ...proxy, signal, strictProxy: proxy.connectionProxyEnabled === true || proxy.strictProxy === true });
    if (!response.ok) return fallback(`HTTP ${response.status}`);
    const models = parseOpenAIModels(await response.json());
    if (!models.length) return fallback("empty catalog");
    catalogCache.set(key, { models, expiresAt: Date.now() + OPENAI_MODELS_CONFIG.cacheTtlMs });
    return { models };
  } catch { return fallback(); }
}
