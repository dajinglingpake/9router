import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";

const pricingUrl = "https://aistudio.google.com/docs/pricing";
let cached;
let pending;

export function geminiProjectQuotaUrl(projectId) {
  return /^[a-z][a-z0-9-]{4,62}$/.test(projectId || "")
    ? `https://console.cloud.google.com/apis/api/generativelanguage.googleapis.com/quotas?project=${projectId}` : null;
}

export function getGeminiFreeTier(id, prices, snapshots, now = Date.now()) {
  const samples = snapshots.map(snapshot => {
    const age = now - Date.parse(snapshot?.observedAt);
    return age >= 0 && age < 86400000 ? snapshot?.models?.[id] : null;
  });
  if (samples.length && samples.every(sample => sample && Object.values(sample).some(metric => metric.limit === 0))) return { isFree: false };
  const family = id.match(/^(gemma-\d+)-/)?.[1];
  const price = prices.get(id) || prices.get(family);
  if (price) return { isFree: price.isFree, pricingUrl: price.url };
  // Some active model IDs have a project-specific free quota but no pricing
  // table of their own. Only use a recent official observation as evidence.
  const i = samples.findIndex(sample => sample && ["rpm", "tpm", "rpd"].every(key => sample[key]?.limit > 0));
  if (i >= 0) return { isFree: true, pricingUrl: geminiProjectQuotaUrl(snapshots[i].projectId), freeTierCheckedAt: snapshots[i].observedAt };
  return {};
}

export function parseGeminiPricing(markdown) {
  const prices = new Map();
  for (const section of markdown.split(/^## /m).slice(1)) {
    const anchor = section.split("\n", 1)[0].match(/\{%\s*id="([\w.-]+)"\s*%\}/)?.[1];
    if (!anchor) continue;
    // Compare standard input AND output prices in the Free Tier column only.
    const standard = section.includes("{% tab ") ? section.match(/\{% tab title="Standard" %\}([\s\S]*?)\{% \/tab %\}/)?.[1] : section;
    const table = standard?.match(/\{% table %\}([\s\S]*?)\{% \/table %\}/)?.[1];
    if (!table) continue;
    const [header, ...rows] = table.split(/^\s*---\s*$/m).map(row => [...row.matchAll(/^\s*\* ([^\n]+)/gm)].map(m => m[1].trim()));
    const column = header.indexOf("Free Tier");
    if (column < 0) continue;
    const input = rows.find(r => /^Input price\b/i.test(r[0]))?.[column];
    const output = rows.find(r => /^Output price\b/i.test(r[0]))?.[column];
    if (!input || !output) continue;
    const isFree = [input, output].every(cell => /^free of charge[.!]?$/i.test(cell));
    const codes = section.match(/\{% left-column[^%]*%\}([\s\S]*?)\{% \/left-column %\}/)?.[1] || "";
    for (const id of [anchor, ...[...codes.matchAll(/`([\w.-]+)`/g)].map(m => m[1])]) {
      prices.set(id, { isFree, url: pricingUrl + "#" + anchor });
    }
  }
  return prices;
}

export async function getGeminiPricing(forceRefresh = false) {
  if (pending) return pending;
  if (!forceRefresh && cached?.expiresAt > Date.now()) return cached.prices;
  pending = (async () => {
    let prices = new Map();
    try {
      const response = await proxyAwareFetch(pricingUrl + ".md?hl=en", {
        headers: { Accept: "text/markdown" }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5000),
      });
      if (response.ok) prices = parseGeminiPricing(await response.text());
    } catch { /* Pricing is optional; discovery still works if Google Docs is unavailable. */ }
    cached = { prices, expiresAt: Date.now() + (prices.size ? 3600000 : 60000) };
    return prices;
  })().finally(() => { pending = null; });
  return pending;
}
