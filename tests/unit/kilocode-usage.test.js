import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { parseQuotaData } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
const account = { provider: "kilocode", accessToken: "test-token" };
const free = { date: "2026-11-11", model: "test/free:free", request_count: 1, total_cost: 0, total_input_tokens: 31, total_output_tokens: 47 };

function mockProfile(balance, report) {
  proxyAwareFetch.mockImplementation(async url => new URL(url).pathname.endsWith("/balance") ? balance : report);
}

describe("Kilo Code quota tracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-11T23:55:00Z"));
    proxyAwareFetch.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("shows a real zero balance, counts a free request, and converts paid microdollars only once", async () => {
    mockProfile(Response.json({ balance: 0 }), Response.json({ usage: [
      free,
      { ...free, model: "paid/model", request_count: 2, total_cost: 1234 },
      { ...free, date: "2026-11-10", request_count: 9, total_cost: 9_000_000 },
    ] }));
    const result = await getUsageForProvider(account);
    expect(parseQuotaData("kilocode", result)).toMatchObject([{ total: 0, currency: "USD", isCreditBalance: true, balanceLabel: "$0.00" }]);
    expect(result.kiloUsage.daily).toMatchObject({
      date: "2026-11-11", requests: 3, costUsd: 0.001234,
      models: [
        { model: free.model, requests: 1, costUsd: 0, inputTokens: 31, outputTokens: 47 },
        { model: "paid/model", requests: 2, costUsd: 0.001234 },
      ],
    });
    expect(result.kiloUsage.detailUrl).toBe("https://app.kilo.ai/usage");
    expect(result.kiloUsage.freeLimitReference.requestsPerHour).toBe(300);
    const url = new URL(proxyAwareFetch.mock.calls[1][0]);
    expect(url.searchParams.get("viewType")).toBe("personal");
    expect(url.searchParams.get("groupByModel")).toBe("true");
  });

  it("matches organization scope for both queries and uses the connection proxy", async () => {
    const proxy = { connectionProxyEnabled: true, strictProxy: true };
    mockProfile(Response.json({ balance: 0.001234 }), Response.json({ usage: [] }));
    const result = await getUsageForProvider({ ...account, providerSpecificData: { orgId: "org-1" } }, proxy);
    for (const [url, options, actualProxy] of proxyAwareFetch.mock.calls) {
      expect(new URL(url).origin).toBe("https://api.kilo.ai");
      expect(options.headers).toMatchObject({ Authorization: "Bearer test-token", "X-KiloCode-OrganizationId": "org-1" });
      expect(options.redirect).toBe("error");
      expect(actualProxy).toBe(proxy);
    }
    expect(new URL(proxyAwareFetch.mock.calls[1][0]).searchParams.get("viewType")).toBe("org-1");
    expect(parseQuotaData("kilocode", result)[0].balanceLabel).toBe("$0.001234");
    expect(result.kiloUsage.daily).toMatchObject({ requests: 0, models: [] });
    expect(result.kiloUsage.detailUrl).toBe("https://app.kilo.ai/organizations/org-1/usage-details");
  });

  it("keeps usage when the balance is missing and never substitutes a zero", async () => {
    mockProfile(Response.json({}), Response.json({ usage: [free] }));
    const result = await getUsageForProvider(account);
    expect(result.quotas).toEqual({});
    expect(result.kiloUsage.daily.requests).toBe(1);
    expect(result.kiloUsage.warning).toContain("余额");
  });

  it("keeps the balance when the usage service fails or returns malformed data", async () => {
    for (const report of [new Response(null, { status: 503 }), Response.json({ usage: [{ ...free, total_cost: null }] })]) {
      mockProfile(Response.json({ balance: 3 }), report);
      const result = await getUsageForProvider(account);
      expect(result.quotas["付费可用余额"].total).toBe(3);
      expect(result.kiloUsage.daily).toBeNull();
      expect(result.kiloUsage.warning).toContain("用量");
    }
  });

  it("reports failed authentication without exposing a balance or the upstream body", async () => {
    await getUsageForProvider({ provider: "kilocode" });
    expect(proxyAwareFetch).not.toHaveBeenCalled();
    mockProfile(new Response("secret", { status: 401 }), new Response("secret", { status: 401 }));
    const result = await getUsageForProvider(account);
    expect(result.message).toContain("HTTP 401");
    expect(result.message).not.toContain("secret");
    expect(result).not.toHaveProperty("quotas");
  });
});
