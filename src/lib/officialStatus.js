import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { normalizeOfficialStatus, OFFICIAL_STATUS_URL } from "@/shared/utils/officialStatus.js";

const CACHE_MS = 60_000;
let cached = null;
let pending = null;
let nextCheckAt = 0;

async function readFeed(path) {
  const response = await proxyAwareFetch(`${OFFICIAL_STATUS_URL}/api/v2/${path}.json`, {
    headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Official status unavailable");
  return response.json();
}

export async function getOfficialStatus() {
  if (pending) return pending;
  if (cached && Date.now() < nextCheckAt) return cached;
  pending = (async () => {
    try {
      const [summary, components, incidents] = await Promise.all([
        readFeed("summary"), readFeed("components"), readFeed("incidents"),
      ]);
      cached = normalizeOfficialStatus(summary, components, incidents, new Date().toISOString());
    } catch {
      cached = { ...(cached || { fetchedAt: null, components: [], incidents: [], historyCount: 0 }),
        stale: true, error: "暂时无法更新官方状态，请查看官方页面。" };
    } finally {
      nextCheckAt = Date.now() + CACHE_MS;
      pending = null;
    }
    return cached;
  })();
  return pending;
}
