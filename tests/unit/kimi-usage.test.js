import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { USAGE_SUPPORTED_PROVIDERS, USAGE_APIKEY_PROVIDERS } from "../../src/shared/constants/providers.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ACTIVE_USAGE = {
  user: {
    membership: { level: "LEVEL_ADVANCED" },
  },
  usage: {
    limit: "100",
    used: "35",
    remaining: "65",
    resetTime: "2026-08-01T00:00:00Z",
  },
  limits: [
    {
      window: { type: "rate" },
      detail: {
        limit: "60",
        remaining: "40",
        resetTime: "2026-07-29T12:00:00Z",
      },
    },
  ],
};

describe("kimi registry usage flags", () => {
  it("exposes usage + usageApikey so OAuth and apikey cards appear on /quota", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("kimi");
    expect(USAGE_APIKEY_PROVIDERS).toContain("kimi");
  });

  it("registers transport.usage url when present (optional)", () => {
    // Provider may or may not put usage url on transport; handler has its own constant.
    expect(PROVIDERS.kimi).toBeTruthy();
  });
});

describe("getUsageForProvider(kimi) auth selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("OAuth path: Bearer + X-Msh-* (not chat x-api-key)", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(ACTIVE_USAGE));

    const usage = await getUsageForProvider({
      provider: "kimi",
      accessToken: "tok-abc",
      providerSpecificData: { deviceId: "stable-device-1" },
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Allegro");
    expect(usage.quotas.Weekly).toMatchObject({
      used: 35,
      total: 100,
      remainingPercentage: 65,
    });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe(KIMI_USAGE_URL);
    expect(opts.method).toBe("GET");
    expect(opts.headers.Authorization).toBe("Bearer tok-abc");
    expect(opts.headers["x-api-key"]).toBeUndefined();
    expect(opts.headers["X-Msh-Platform"]).toBe("9router");
    expect(opts.headers["X-Msh-Device-Id"]).toBe("stable-device-1");
    expect(opts.headers["X-Msh-Version"]).toBeTruthy();
  });

  it("apikey path: x-api-key only (no Bearer / X-Msh)", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(ACTIVE_USAGE));

    const usage = await getUsageForProvider({
      provider: "kimi",
      apiKey: "sk-test-123",
    });

    expect(usage.message).toBeUndefined();
    expect(usage.quotas.Weekly.used).toBe(35);

    const [, opts] = proxyAwareFetch.mock.calls[0];
    expect(opts.headers["x-api-key"]).toBe("sk-test-123");
    expect(opts.headers.Authorization).toBeUndefined();
    expect(opts.headers["X-Msh-Platform"]).toBeUndefined();
  });

  it("prefers apiKey over accessToken when both present", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(ACTIVE_USAGE));

    await getUsageForProvider({
      provider: "kimi",
      accessToken: "tok-abc",
      apiKey: "sk-prefer-me",
    });

    const [, opts] = proxyAwareFetch.mock.calls[0];
    expect(opts.headers["x-api-key"]).toBe("sk-prefer-me");
    expect(opts.headers.Authorization).toBeUndefined();
    expect(opts.headers["X-Msh-Platform"]).toBeUndefined();
  });

  it("maps membership levels to plan display names", async () => {
    for (const [level, plan] of [
      ["LEVEL_BASIC", "Moderato"],
      ["LEVEL_INTERMEDIATE", "Allegretto"],
      ["LEVEL_ADVANCED", "Allegro"],
      ["LEVEL_STANDARD", "Vivace"],
    ]) {
      proxyAwareFetch.mockResolvedValueOnce(
        jsonResponse({
          user: { membership: { level } },
          usage: { limit: "10", used: "1", remaining: "9" },
        }),
      );
      const usage = await getUsageForProvider({
        provider: "kimi",
        accessToken: "t",
      });
      expect(usage.plan).toBe(plan);
    }
  });

  it("parses Weekly + Ratelimit; does not put absolute remaining on quota rows", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(ACTIVE_USAGE));

    const usage = await getUsageForProvider({
      provider: "kimi",
      accessToken: "tok",
    });

    // Absolute remaining would break getRemainingPercentage (treats it as 0-100 %)
    expect(usage.quotas.Weekly.remaining).toBeUndefined();
    expect(usage.quotas.Weekly.remainingPercentage).toBe(65);
    expect(usage.quotas.Ratelimit).toMatchObject({
      used: 20,
      total: 60,
      remainingPercentage: expect.closeTo(40 / 60 * 100, 5),
    });
    expect(usage.quotas.Ratelimit.remaining).toBeUndefined();
  });

  it.each([{ accessToken: "tok" }, { apiKey: "sk-test" }])("shows current 5h/monthly ratios with %j", async credentials => {
    // Captured /coding/v1/usages shape: limits repeats 5h rounded to an integer.
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      usages: {
        limit_5h: { used_ratio: 0.0166, reset_time: "2026-11-05T12:37:30Z" },
        limit_month_total: { used_ratio: 0.0104, reset_time: "2026-12-06T00:00:00Z" },
        limit_month_code: { used_ratio: 0.0104, reset_time: "2026-12-06T00:00:00Z" },
      },
      limits: [{
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: { limit: "100", used: "2", remaining: "98", resetTime: "2026-11-05T12:37:30.543877Z" },
      }],
    }));
    const usage = await getUsageForProvider({ provider: "kimi", ...credentials });
    const rows = parseQuotaData("kimi", usage);
    expect(rows.map(row => row.name)).toEqual(["5h", "Monthly (Total)", "Monthly (Code)"]);
    expect(rows[0]).toMatchObject({
      used: expect.closeTo(1.66, 5), total: 100,
      remainingPercentage: expect.closeTo(98.34, 5), resetAt: "2026-11-05T12:37:30.000Z",
    });
    for (const row of rows.slice(1)) {
      expect(row).toMatchObject({ remainingPercentage: expect.closeTo(98.96, 5), resetAt: "2026-12-06T00:00:00.000Z" });
    }
    expect(usage.quotas.Ratelimit).toBeUndefined();
  });

  it("identifies the legacy 300-minute rate window as 5h", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      ...ACTIVE_USAGE,
      limits: [{ ...ACTIVE_USAGE.limits[0], window: { duration: "300", timeUnit: "TIME_UNIT_MINUTE" } }],
    }));
    const usage = await getUsageForProvider({ provider: "kimi", accessToken: "tok" });
    expect(Object.keys(usage.quotas)).toEqual(["Weekly", "5h"]);
    expect(usage.quotas["5h"].remainingPercentage).toBeCloseTo(40 / 60 * 100, 5);
  });

  it("preserves zero usage, clamps exhausted quotas and falls back when a ratio is invalid", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      usages: {
        limit_5h: { used_ratio: "invalid" },
        limit_month_total: { used_ratio: 0 },
        limit_month_code: { used_ratio: "1.05" },
      },
      limits: [{
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: { limit: 100, remaining: 80 },
      }],
    }));
    const usage = await getUsageForProvider({ provider: "kimi", accessToken: "tok" });
    expect(usage.quotas["5h"].remainingPercentage).toBe(80);
    expect(usage.quotas["Monthly (Total)"].remainingPercentage).toBe(100);
    expect(usage.quotas["Monthly (Code)"].remainingPercentage).toBe(0);
  });

  it("does not invent a 5h quota when upstream only supplies monthly usage", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      usages: { limit_month_total: { used_ratio: 0.2 }, limit_5h: { used_ratio: null } },
    }));
    const usage = await getUsageForProvider({ provider: "kimi", accessToken: "tok" });
    expect(Object.keys(usage.quotas)).toEqual(["Monthly (Total)"]);
    expect(usage.quotas["Monthly (Total)"].remainingPercentage).toBe(80);
  });

  it("surfaces re-authorize message only on 401 unauthenticated", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse(
        {
          code: "unauthenticated",
          details: [
            {
              debug: {
                reason: "REASON_INVALID_AUTH_TOKEN",
                localizedMessage: { message: "Invalid auth token" },
              },
            },
          ],
        },
        401,
      ),
    );

    const usage = await getUsageForProvider({
      provider: "kimi",
      accessToken: "expired",
    });

    expect(usage.message).toMatch(/expired|re-authorize/i);
    expect(usage.message).not.toMatch(/subscribe|permission/i);
    expect(usage.quotas).toBeUndefined();
  });

  it("maps 403 REASON_FEATURE_NO_PERMISSION to subscribe message (not expired)", async () => {
    // Live capture: valid OAuth JWT still returns 403 permission_denied when
    // the account has no Kimi Code usage entitlement.
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse(
        {
          code: "permission_denied",
          details: [
            {
              type: "common.error.v1.ErrorDetail",
              debug: {
                reason: "REASON_FEATURE_NO_PERMISSION",
                localizedMessage: {
                  locale: "en-US",
                  message:
                    "You do not have permission to use this feature. Please subscribe to access.",
                },
              },
            },
          ],
        },
        403,
      ),
    );

    const usage = await getUsageForProvider({
      provider: "kimi",
      accessToken: "valid-but-no-sub",
      providerSpecificData: { deviceId: "stable-device-1" },
    });

    expect(usage.message).toMatch(/permission|subscribe/i);
    expect(usage.message).not.toMatch(/expired|re-authorize/i);
    // Must not trip usage-route AUTH_EXPIRED_PATTERNS force-refresh loop
    expect(usage.message.toLowerCase()).not.toMatch(/expired|re-authorize|unauthorized|401/);
  });

  it("formatKimiUsageError distinguishes 401 vs 403 feature gate", async () => {
    const { formatKimiUsageError } = await import(
      "../../open-sse/services/usage/kimi.js"
    );
    expect(formatKimiUsageError(401, '{"code":"unauthenticated"}')).toMatch(
      /expired|re-authorize/i,
    );
    expect(
      formatKimiUsageError(
        403,
        JSON.stringify({
          code: "permission_denied",
          details: [
            {
              debug: {
                reason: "REASON_FEATURE_NO_PERMISSION",
                localizedMessage: {
                  message: "You do not have permission to use this feature.",
                },
              },
            },
          ],
        }),
      ),
    ).toMatch(/permission|subscribe/i);
  });

  it("returns tracked-per-request message when usage limit missing", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        user: { membership: { level: "LEVEL_BASIC" } },
        usage: {},
      }),
    );

    const usage = await getUsageForProvider({
      provider: "kimi",
      accessToken: "tok",
    });

    expect(usage.plan).toBe("Moderato");
    expect(usage.message).toMatch(/tracked per request/i);
  });

  it("returns missing-credentials message when neither token nor key", async () => {
    const usage = await getUsageForProvider({ provider: "kimi" });
    expect(usage.message).toMatch(/token|key|credential/i);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });
});

describe("parseQuotaData(kimi)", () => {
  it("forwards remainingPercentage for dashboard bars", () => {
    const rows = parseQuotaData("kimi", {
      plan: "Allegro",
      quotas: {
        Weekly: {
          used: 35,
          total: 100,
          remainingPercentage: 65,
          resetAt: "2026-08-01T00:00:00.000Z",
        },
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Weekly",
      used: 35,
      total: 100,
      remainingPercentage: 65,
    });
  });
});
