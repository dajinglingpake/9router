import { createHash } from "node:crypto";
import nvidia from "open-sse/providers/registry/nvidia.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { parseNvidiaModels } from "@/shared/utils/nvidiaModels";

const cache = globalThis.__ninerouterNvidiaModels ||= new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;

export async function resolveNvidiaModels(connection, { forceRefresh = false } = {}) {
  const token = connection.apiKey || connection.accessToken;
  if (!token) return { models: [], status: 401, error: "NVIDIA account credentials are missing." };

  const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
  const key = createHash("sha256").update(JSON.stringify([connection.id, token, proxy])).digest("hex");
  const now = Date.now();
  for (const [id, entry] of cache) if (!entry.pending && entry.expiresAt <= now) cache.delete(id);
  const previous = cache.get(key);
  if (previous?.pending || (previous && !forceRefresh)) return previous.result;

  const entry = { pending: true, expiresAt: 0 };
  entry.result = (async () => {
    try {
      const response = await proxyAwareFetch(nvidia.transport.validateUrl, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        cache: "no-store", redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }, { ...proxy, strictProxy: proxy.strictProxy || proxy.connectionProxyEnabled });
      if (!response.ok) return { models: [], status: response.status, error: `Failed to fetch NVIDIA models (HTTP ${response.status}).` };
      return { models: parseNvidiaModels(await response.json()) };
    } catch {
      return { models: [], status: 502, error: "Failed to fetch NVIDIA models." };
    }
  })().then(result => {
    entry.expiresAt = Date.now() + (result.error ? FETCH_TIMEOUT_MS : CACHE_TTL_MS);
    entry.pending = false;
    return result;
  });
  cache.set(key, entry);
  return entry.result;
}
