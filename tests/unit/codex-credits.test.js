import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), settings: vi.fn(), updateSettings: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
vi.mock("@/lib/providerUsage.js", () => ({ loadConnectionUsage: vi.fn() }));
vi.mock("@/lib/codexModels", () => ({ resolveCodexCatalog: async () => ({ models: [{ id: "gpt-6-luna", name: "Luna" }], accounts: [] }) }));
vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.settings, updateSettings: mocks.updateSettings,
  getProviderConnections: async () => [],
  getProviderConnectionById: vi.fn(), updateProviderConnection: vi.fn(),
}));

import { getCodexUsage } from "../../open-sse/services/usage/codex.js";
import { getAccountQuotaState, loadRoutingQuotas } from "@/sse/local/quotaRouting.js";
import { CODEX_ROUTING_DEFAULTS, getCodexRoutingPolicy, normalizeCodexRouting, usesQuotaRouting } from "@/sse/local/routingPolicy.js";
import { parseQuotaData } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import { GET, PATCH } from "@/app/api/settings/codex-routing/route.js";

const MODEL = "gpt-6.1-sol";
const resetAt = "2030-01-01T00:00:00.000Z";
const quota = used => ({ used, total: 100, resetAt });
const credits = { hasCredits: true, unlimited: false, balance: 12.5 };
const usage = (extra = {}) => ({ limitReached: true, quotas: { session: quota(100), weekly: quota(20) }, credits, ...extra });
const policy = (allowCredits = false) => ({ ...CODEX_ROUTING_DEFAULTS, allowCredits });
const state = (data, allowCredits = false, model = MODEL, connection = {}) => getAccountQuotaState(connection, model, data, policy(allowCredits));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.mockResolvedValue({});
});

describe("Codex credit balance", () => {
  it.each([
    [{ has_credits: true, unlimited: false, balance: "12.5" }, credits],
    [{ has_credits: false, unlimited: false, balance: "0" }, { hasCredits: false, unlimited: false, balance: 0 }],
    [{ has_credits: true, unlimited: true, balance: null }, { hasCredits: true, unlimited: true, balance: null }],
    [{ has_credits: true, unlimited: false, balance: "invalid" }, { hasCredits: true, unlimited: false, balance: null }],
    [undefined, null],
  ])("normalizes upstream credits without confusing them with reset vouchers: %j", async (raw, expected) => {
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({
      credits: raw,
      rate_limit: { primary_window: { used_percent: 100, reset_at: 1893456000 } },
      rate_limit_reset_credits: { available_count: 2 },
    }) });
    const result = await getCodexUsage("fixture-token");
    expect(result.credits).toEqual(expected);
    expect(result.resetCredits.availableCount).toBe(2);
    expect(result.quotas.session.used).toBe(100);
  });

  it("shows absolute credit points separately from percentage windows", () => {
    const rows = parseQuotaData("codex", usage());
    expect(rows.map(row => row.name)).toEqual(["5h", "Weekly", "Credits"]);
    expect(rows.at(-1)).toMatchObject({ isCreditBalance: true, total: 12.5, balanceLabel: "12.5 credits" });
    expect(rows.at(-1)).not.toHaveProperty("remaining");
  });

  it.each([
    [{ ...credits, balance: 0 }, "0 credits"],
    [{ ...credits, unlimited: true, balance: null }, "Unlimited credits"],
    [{ ...credits, balance: null }, "Available · balance unavailable"],
    [{ ...credits, hasCredits: false, balance: null }, "Balance unavailable"],
  ])("displays zero, unlimited and unknown balances honestly: %j", (value, label) => {
    expect(parseQuotaData("codex", { credits: value }).at(-1).balanceLabel).toBe(label);
  });

  it("omits the balance row when the upstream does not report credits", () => {
    expect(parseQuotaData("codex", { quotas: {}, credits: null })).toEqual([]);
  });
});

describe("Codex credits opt-in", () => {
  it("disables credit spending by default and still queries quotas for the inherited strategy", async () => {
    const config = getCodexRoutingPolicy({});
    expect(config.allowCredits).toBe(false);
    expect(usesQuotaRouting(config)).toBe(true);
    const { loadConnectionUsage } = await import("@/lib/providerUsage.js");
    loadConnectionUsage.mockResolvedValue(usage());
    await loadRoutingQuotas([{ id: "credits-default-account" }], config);
    expect(loadConnectionUsage).toHaveBeenCalled();
    expect(state(usage()).exhausted).toBe(true);
    expect(state(usage()).retryAt).toBe(resetAt);
  });

  it("allows credits to extend exhausted session or weekly quotas only after opting in", () => {
    for (const data of [usage(), usage({ quotas: { session: quota(20), weekly: quota(100) } })]) {
      expect(state(data, true)).toMatchObject({ exhausted: false, retryAt: null, usedPercent: 100 });
    }
  });

  it("checks upstream quota locks even when credits is the only enabled policy", () => {
    expect(usesQuotaRouting(policy(true))).toBe(true);
    expect(state(usage(), true, MODEL, { "modelLock_codex-quota-normal": resetAt }))
      .toMatchObject({ exhausted: true, retryAt: resetAt });
  });

  it.each([
    { ...credits, hasCredits: false },
    { ...credits, balance: 0 },
    null,
  ])("does not bypass exhaustion without usable credits: %j", value => {
    expect(state(usage({ credits: value }), true).exhausted).toBe(true);
  });

  it.each([
    { ...credits, balance: null },
    { ...credits, unlimited: true, balance: 0 },
  ])("accepts an explicit available or unlimited credit grant: %j", value => {
    expect(state(usage({ credits: value }), true).exhausted).toBe(false);
  });

  it("requires opting in for credit-only accounts without subscription windows", () => {
    const data = usage({ quotas: {}, limitReached: false });
    expect(state(data).exhausted).toBe(true);
    expect(state(data, true).exhausted).toBe(false);
  });

  it("does not treat reset vouchers as spendable credits", () => {
    expect(state(usage({ credits: null, resetCredits: { availableCount: 5 } }), true).exhausted).toBe(true);
  });

  it("does not extend Spark quotas using normal credits", () => {
    const data = usage({ sparkLimitReached: true, quotas: { spark_session: quota(100) } });
    expect(state(data, true, "gpt-5.3-codex-spark").exhausted).toBe(true);
  });

  it("continues using an account's included quota with credits disabled", () => {
    expect(state(usage({ limitReached: false, quotas: { session: quota(20), weekly: quota(50) } })).exhausted).toBe(false);
  });

  it("preserves the existing unknown and expired-window behavior", () => {
    expect(state(null).exhausted).toBe(false);
    expect(state(usage({ quotas: { session: { ...quota(100), resetAt: "2020-01-01T00:00:00Z" } } })).exhausted).toBe(false);
  });
});

describe("Codex credits settings", () => {
  it("reads the default, saves the opt-in, and preserves it in partial updates", async () => {
    expect((await (await GET()).json()).config.allowCredits).toBe(false);
    const response = await PATCH(new Request("http://localhost/api/settings/codex-routing", {
      method: "PATCH", body: JSON.stringify({ allowCredits: true }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.updateSettings).toHaveBeenCalledWith({ localCodexRouting: expect.objectContaining({ allowCredits: true }) });
    mocks.settings.mockResolvedValue({ localCodexRouting: (await response.json()).config });
    const updated = await PATCH(new Request("http://localhost/api/settings/codex-routing", {
      method: "PATCH", body: JSON.stringify({ quotaFailover: true }),
    }));
    expect((await updated.json()).config).toMatchObject({ allowCredits: true, quotaFailover: true });
  });

  it.each(["true", 1, null])("rejects non-boolean credit policy values: %j", value => {
    expect(() => normalizeCodexRouting({ allowCredits: value })).toThrow();
  });
});
