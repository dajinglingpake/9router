import { describe, expect, it, vi } from "vitest";
import { getGeminiChatModels } from "@/shared/utils/geminiModels";
import { resolveGeminiModels, resolveGeminiChatCatalog } from "@/lib/geminiModels";
import { getGeminiFreeTier, getGeminiPricing, parseGeminiPricing } from "@/lib/geminiPricing";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";

vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => ({ connectionProxyEnabled: true }) }));
const record = (id, methods = ["generateContent"]) => ({ name: "models/" + id, displayName: id, supportedGenerationMethods: methods });

describe("Gemini model discovery", () => {
  it("respects official zero quotas and expires project observations without inferring prices from model names", () => {
    const now = Date.parse("2026-11-25T03:45:00Z");
    const snapshot = { projectId: "example-project", observedAt: new Date(now).toISOString(), models: {
      a: { rpm: { limit: 5 }, tpm: { limit: 20 }, rpd: { limit: 10 } }, b: { rpd: { limit: 0 } },
    } };
    const prices = new Map([["b", { isFree: true, url: "official" }]]);
    expect(getGeminiFreeTier("b", prices, [snapshot], now).isFree).toBe(false);
    expect(getGeminiFreeTier("a", prices, [snapshot], now).isFree).toBe(true);
    expect(getGeminiFreeTier("a", prices, [snapshot], now + 86400001).isFree).toBeUndefined();
    expect(getGeminiFreeTier("a-latest", prices, [snapshot], now).isFree).toBeUndefined();
  });
  it("marks free only from the official standard input and output pricing, and rechecks on refresh", async () => {
    const section = (id, input, output) => `## Model {% id="${id}" %}
{% tab title="Standard" %}
{% table %}
* Feature
* Free Tier
* Paid Tier
---
* Input price
* ${input}
* $2
---
* Output price (including thinking tokens)
* ${output}
* $3
{% /table %}
{% /tab %}
{% tab title="Batch" %}
Free of charge
{% /tab %}`;
    const doc = section("fresh", "Free of charge", "Free of charge") + "\n" + section("paid", "Free of charge", "Not available");
    expect(parseGeminiPricing(doc).get("paid").isFree).toBe(false);
    proxyAwareFetch.mockResolvedValueOnce(new Response(doc));
    expect((await getGeminiPricing(true)).get("fresh").isFree).toBe(true);
    proxyAwareFetch.mockResolvedValueOnce(new Response(section("fresh", "Not available", "Not available")));
    expect((await getGeminiPricing(true)).get("fresh").isFree).toBe(false);
    proxyAwareFetch.mockClear();
  });
  it("selects text generation models and preserves their advertised limits", () => {
    const rows = ["gemini-future", "gemma-new", "gemini-nano-banana-2", "lyria-3", "gemini-tts-preview", "gemini-flash-image"].map(id => record(id));
    rows.push(record("gemini-future"), record("aqa", ["generateAnswer"]), record("voice", ["bidiGenerateContent"]), record("embed", ["embedContent"]), null);
    rows[0].inputTokenLimit = 321000;
    const models = getGeminiChatModels(rows);
    expect(models.map(m => m.id)).toEqual(["gemini-future", "gemma-new"]);
    expect(models[0].capabilities.contextWindow).toBe(321000);
  });

  it("reads all pages with the account proxy, coalesces requests, isolates keys and rejects incomplete catalogs", async () => {
    const account = { provider: "gemini", id: "one", apiKey: "fixture" };
    proxyAwareFetch.mockResolvedValueOnce(Response.json({ models: [record("gemini-a")], nextPageToken: "next token" }))
      .mockResolvedValueOnce(Response.json({ models: [record("gemini-a"), record("gemma-b"), record("voice", ["bidiGenerateContent"])] }));
    const [raw, chat] = await Promise.all([resolveGeminiModels(account), resolveGeminiChatCatalog([account])]);
    expect(raw.models.map(m => m.name)).toEqual(["models/gemini-a", "models/gemma-b", "models/voice"]);
    expect(chat.models.map(m => m.id)).toEqual(["gemini-a", "gemma-b"]);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    const [url, options, proxy] = proxyAwareFetch.mock.calls[1];
    expect(new URL(url).searchParams.get("pageToken")).toBe("next token");
    expect(url).not.toContain("fixture");
    expect(options.headers["x-goog-api-key"]).toBe("fixture");
    expect(proxy.strictProxy).toBe(true);
    proxyAwareFetch.mockResolvedValueOnce(Response.json({ models: [record("partial")], nextPageToken: "more" }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    const errors = await resolveGeminiChatCatalog([{ ...account, apiKey: "rotated" }]);
    expect(errors.models).toEqual([]);
    expect(errors.warning).toContain("403");
    proxyAwareFetch.mockResolvedValueOnce(Response.json({ models: [record("new")] }));
    const refreshed = await resolveGeminiChatCatalog([account, { ...account, isActive: false }], { forceRefresh: true });
    expect(refreshed.models.map(m => m.id)).toEqual(["new"]);
  });
});
