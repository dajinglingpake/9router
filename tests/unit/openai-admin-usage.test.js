import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { OPENAI_USAGE_CONFIG } from "open-sse/providers/registry/openai.js";

const account = { provider: "openai", authType: "apikey", apiKey: "model-key", openaiAdminKey: "admin-secret" };
const page = (results, extra = {}) => Response.json({ data: [{ results }], has_more: false, ...extra });
const cost = (value, currency = "usd") => ({ amount: { value, currency } });
const usage = { num_model_requests: 3, input_tokens: 120, output_tokens: 40 };
let getOpenAIUsage;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-29T04:30:00Z"));
  ({ getOpenAIUsage } = await import("@/lib/openaiUsage.js"));
  proxyAwareFetch.mockReset().mockImplementation(async url => page(url.includes("/costs") ? [cost(1.25)] : [usage]));
});
afterEach(() => vi.useRealTimers());

describe("OpenAI organization usage", () => {
  it("paginates both APIs and aggregates the UTC month without inventing a balance or expiry", async () => {
    proxyAwareFetch.mockImplementation(async rawUrl => {
      const url = new URL(rawUrl);
      const more = !url.searchParams.has("page");
      return page(url.pathname.endsWith("/costs") ? (more ? [cost(1.25), cost(2, "eur")] : [cost(0.75)]) : [usage],
        more ? { has_more: true, next_page: "next" } : {});
    });
    const proxy = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.test", strictProxy: true };
    const result = await getOpenAIUsage(account, proxy);
    expect(result.openaiUsage).toEqual({
      periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-10-29T04:30:00.000Z",
      costs: [{ currency: "USD", amount: 2 }, { currency: "EUR", amount: 2 }],
      requests: 6, inputTokens: 240, outputTokens: 80,
    });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(4);
    for (const [rawUrl, options, resolvedProxy] of proxyAwareFetch.mock.calls) {
      const url = new URL(rawUrl);
      expect(url.origin).toBe("https://api.openai.com");
      expect(url.searchParams.get("start_time")).toBe(String(Date.parse("2026-10-01T00:00:00Z") / 1000));
      expect(url.searchParams.get("end_time")).toBe(String(url.pathname.endsWith("/costs")
        ? Date.parse("2026-10-30T00:00:00Z") / 1000 : Date.now() / 1000));
      expect(url.searchParams.get("bucket_width")).toBe("1d");
      expect(url.searchParams.get("limit")).toBe("31");
      expect(url.searchParams.getAll("group_by")).toEqual(url.pathname.endsWith("/costs") ? [] : ["model", "service_tier", "batch"]);
      expect(options).toMatchObject({ headers: { Authorization: "Bearer admin-secret" }, redirect: "error", signal: expect.any(AbortSignal) });
      expect(resolvedProxy).toMatchObject(proxy);
      expect(JSON.stringify(options)).not.toContain(account.apiKey);
    }
    expect(JSON.stringify(result)).not.toContain(account.openaiAdminKey);
    expect(result).not.toHaveProperty("balance");
    expect(result.openaiUsage).not.toHaveProperty("expiresAt");
  });

  it("includes today's official costs when the costs API only returns complete daily buckets", async () => {
    vi.setSystemTime(new Date("2026-10-30T06:28:55Z"));
    const todayEnd = Date.parse("2026-10-31T00:00:00Z") / 1000;
    const rows = [
      { model: "gpt-6.1-sol", service_tier: "default", batch: false, num_model_requests: 729,
        input_tokens: 93070147, output_tokens: 489686, input_cached_tokens: 88597386,
        input_cache_write_tokens: 4460205, input_cache_write_30m_tokens: 4460205 },
      { model: "gpt-6.1-sol", service_tier: "default", batch: false, num_model_requests: 403,
        input_tokens: 56633966, output_tokens: 245944, input_cached_tokens: 53020825,
        input_cache_write_tokens: 3611910, input_cache_write_30m_tokens: 3611910 },
    ];
    proxyAwareFetch.mockImplementation(async rawUrl => {
      const url = new URL(rawUrl);
      if (!url.pathname.endsWith("/costs")) return page(rows);
      return page(Number(url.searchParams.get("end_time")) >= todayEnd
        ? [cost(24.9322231), cost(16.7937595)] : [cost(24.9322231)]);
    });
    const result = (await getOpenAIUsage(account)).openaiUsage;
    expect(result.costs).toEqual([{ currency: "USD", amount: 41.7259826 }]);
    expect(result).toMatchObject({ periodEnd: "2026-10-30T06:28:55.000Z", requests: 1132, inputTokens: 149704113, outputTokens: 735630 });
    expect(result).not.toHaveProperty("estimate");
    const { estimateOpenAIUsage } = await import("@/lib/openaiUsageEstimate.js");
    expect(estimateOpenAIUsage(rows)).toMatchObject({ amount: 41.7259826, unpricedRequests: 0 });
  });

  it("includes the final UTC day across a month boundary while querying usage only through now", async () => {
    vi.setSystemTime(new Date("2026-10-31T23:59:59Z"));
    const result = (await getOpenAIUsage(account)).openaiUsage;
    const costsUrl = new URL(proxyAwareFetch.mock.calls.find(([url]) => url.includes("/costs"))[0]);
    const usageUrl = new URL(proxyAwareFetch.mock.calls.find(([url]) => url.includes("/usage/completions"))[0]);
    expect(costsUrl.searchParams.get("end_time")).toBe(String(Date.parse("2026-11-01T00:00:00Z") / 1000));
    expect(usageUrl.searchParams.get("end_time")).toBe(String(Date.now() / 1000));
    expect(result.periodEnd).toBe("2026-10-31T23:59:59.000Z");
  });

  it("deducts paginated estimated usage since the recorded balance, including previous months", async () => {
    const balance = { amount: 61.96, recordedAt: "2026-09-28T15:23:45.000Z" };
    const since = String(Date.parse(balance.recordedAt) / 1000);
    proxyAwareFetch.mockImplementation(async rawUrl => {
      const url = new URL(rawUrl);
      if (url.pathname.endsWith("/costs")) return page([cost(24.93)]);
      if (url.searchParams.get("start_time") !== since) return page([usage]);
      expect(url.searchParams.get("end_time")).toBe(String(Date.now() / 1000));
      return page([{ model: "gpt-6.1-sol", service_tier: "default", batch: false,
        num_model_requests: 1, input_tokens: 0, output_tokens: 50_000 }],
      url.searchParams.has("page") ? {} : { has_more: true, next_page: "balance-next" });
    });
    const result = (await getOpenAIUsage({ ...account, openaiBalance: balance })).openaiUsage;
    expect(result.costs).toEqual([{ currency: "USD", amount: 24.93 }]);
    expect(result.balance).toMatchObject({ ...balance, currency: "USD", remaining: 60.96, estimate: { amount: 1, unpricedRequests: 0 } });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(4);
  });

  it("starts at the recorded amount without querying an empty time range", async () => {
    const balance = { amount: 61.96, recordedAt: new Date().toISOString() };
    const result = (await getOpenAIUsage({ ...account, openaiBalance: balance })).openaiUsage.balance;
    expect(result).toMatchObject({ ...balance, remaining: 61.96, estimate: { amount: 0 } });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it("isolates cached balances by amount and recording time, preserving negative remaining amounts", async () => {
    const recordedAt = "2026-10-28T03:00:00.000Z";
    proxyAwareFetch.mockImplementation(async url => page(url.includes("/costs") ? [cost(0)] : [{
      model: "gpt-6.1-sol", service_tier: "default", batch: false,
      num_model_requests: 1, input_tokens: 0, output_tokens: 100_000,
    }]));
    const read = openaiBalance => getOpenAIUsage({ ...account, openaiBalance });
    await read(undefined);
    expect((await read({ amount: 2, recordedAt })).openaiUsage.balance.remaining).toBe(1);
    expect((await read({ amount: 0.5, recordedAt })).openaiUsage.balance.remaining).toBe(-0.5);
    expect((await read({ amount: 0, recordedAt })).openaiUsage.balance.remaining).toBe(-1);
    expect((await read({ amount: 2, recordedAt: new Date().toISOString() })).openaiUsage.balance.remaining).toBe(2);
    expect((await read(undefined)).openaiUsage).not.toHaveProperty("balance");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(13);
  });

  it("withholds a remaining amount when some requests cannot be priced", async () => {
    const balance = { amount: 61.96, recordedAt: "2026-10-28T03:00:00.000Z" };
    const result = (await getOpenAIUsage({ ...account, openaiBalance: balance })).openaiUsage;
    expect(result.balance).toMatchObject({ remaining: null, estimate: { unpricedRequests: 3 } });
    expect(result.costs).toEqual([{ currency: "USD", amount: 1.25 }]);
  });

  it("keeps monthly statistics available on a balance query failure and retries without caching it", async () => {
    const balance = { amount: 61.96, recordedAt: "2026-10-28T03:00:00.000Z" };
    const since = String(Date.parse(balance.recordedAt) / 1000);
    const fallback = proxyAwareFetch.getMockImplementation();
    proxyAwareFetch.mockImplementation(async url => new URL(url).searchParams.get("start_time") === since
      ? new Response(account.openaiAdminKey, { status: 429 }) : fallback(url));
    for (let i = 0; i < 2; i++) {
      const result = (await getOpenAIUsage({ ...account, openaiBalance: balance })).openaiUsage;
      expect(result.balance).toMatchObject({ remaining: null, error: expect.stringContaining("限流") });
      expect(result.balance.error).not.toContain(account.openaiAdminKey);
      expect(result.costs).toEqual([{ currency: "USD", amount: 1.25 }]);
    }
    expect(proxyAwareFetch).toHaveBeenCalledTimes(6);
  });

  it("caches successful results and refreshes on force, key, proxy, month or TTL changes", async () => {
    await getOpenAIUsage(account);
    await getOpenAIUsage(account);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    await getOpenAIUsage(account, {}, { force: true });
    await getOpenAIUsage({ ...account, openaiAdminKey: "rotated" });
    await getOpenAIUsage(account, { connectionProxyUrl: "http://changed.test" });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(8);
    vi.advanceTimersByTime(OPENAI_USAGE_CONFIG.cacheTtlMs + 1);
    await getOpenAIUsage(account);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(10);
    vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
    await getOpenAIUsage(account);
    expect(new URL(proxyAwareFetch.mock.lastCall[0]).searchParams.get("start_time")).toBe(String(Date.parse("2026-11-01T00:00:00Z") / 1000));
  });

  it("does not query with the model key when Admin Key is absent", async () => {
    const result = await getOpenAIUsage({ ...account, openaiAdminKey: null });
    expect(result.message).toContain("Admin Key");
    expect(result).not.toHaveProperty("openaiUsage");
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("leaves missing cost rows empty rather than inventing a currency or balance", async () => {
    proxyAwareFetch.mockImplementation(async () => page([]));
    expect((await getOpenAIUsage(account)).openaiUsage).toMatchObject({ costs: [], requests: 0, inputTokens: 0, outputTokens: 0 });
  });

  it("estimates money from grouped usage when the official costs API has no rows", async () => {
    proxyAwareFetch.mockImplementation(async url => page(url.includes("/costs") ? [] : [{
      model: "gpt-6.1-sol", service_tier: "default", batch: false,
      num_model_requests: 14, input_tokens: 231814, output_tokens: 37944,
      input_cached_tokens: 149066, input_cache_write_tokens: 82706,
      input_cache_write_30m_tokens: 82706, input_cache_write_12h_tokens: 0,
    }]));
    const result = (await getOpenAIUsage(account)).openaiUsage;
    expect(result.costs).toEqual([]);
    expect(result.estimate.amount).toBeCloseTo(0.6011956, 9);
    expect(result.estimate).toMatchObject({ currency: "USD", unpricedRequests: 0 });
    expect(result.estimate.breakdown[0].components.find(part => part.type === "input").tokens).toBe(42);
  });

  it("prefers an official zero charge to an estimate", async () => {
    proxyAwareFetch.mockImplementation(async url => page(url.includes("/costs") ? [cost(0)] : [usage]));
    const result = (await getOpenAIUsage(account)).openaiUsage;
    expect(result.costs).toEqual([{ currency: "USD", amount: 0 }]);
    expect(result).not.toHaveProperty("estimate");
  });

  it.each([401, 403, 429, 500])("sanitizes HTTP %s errors and does not cache failures", async status => {
    proxyAwareFetch.mockResolvedValueOnce(new Response(account.openaiAdminKey, { status }));
    await expect(getOpenAIUsage(account)).rejects.toThrow(/OpenAI/);
    expect((await getOpenAIUsage(account)).openaiUsage.requests).toBe(3);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(4);
  });

  it.each(["network", "invalid-json", "missing-results", "missing-cursor", "repeated-cursor", "invalid-amount", "invalid-count"])("rejects %s without exposing upstream data", async mode => {
    proxyAwareFetch.mockImplementation(async () => {
      if (mode === "network") throw new Error(account.openaiAdminKey);
      if (mode === "invalid-json") return new Response(account.openaiAdminKey);
      if (mode === "missing-results") return Response.json({ data: [{}] });
      if (mode === "missing-cursor") return page([], { has_more: true });
      if (mode === "repeated-cursor") return page([], { has_more: true, next_page: "same" });
      if (mode === "invalid-amount") return page([cost(account.openaiAdminKey)]);
      return page([cost(1)]);
    });
    const error = await getOpenAIUsage(account).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain(account.openaiAdminKey);
    expect(proxyAwareFetch.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("propagates caller cancellation and enforces a timeout", async () => {
    const controller = new AbortController();
    await getOpenAIUsage(account, { signal: controller.signal });
    const signal = proxyAwareFetch.mock.lastCall[1].signal;
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await getOpenAIUsage(account, {}, { force: true });
    expect(timeout).toHaveBeenCalledWith(OPENAI_USAGE_CONFIG.timeoutMs);
    timeout.mockRestore();
  });
});
