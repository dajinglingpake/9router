import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(), settings: vi.fn(), connection: vi.fn(), connections: vi.fn(), keys: vi.fn(),
  meta: new Map(), snapshot: vi.fn(), usage: vi.fn(),
}));
vi.mock("undici", () => ({ fetch: mocks.fetch }));
vi.mock("@/lib/db/repos/settingsRepo.js", () => ({ getSettings: mocks.settings }));
vi.mock("@/lib/db/repos/connectionsRepo.js", () => ({ getProviderConnectionById: mocks.connection, getProviderConnections: mocks.connections }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeys: mocks.keys }));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: async () => ({
  get: (_sql, [key]) => mocks.meta.has(key) ? { value: mocks.meta.get(key) } : null,
  run: (_sql, [key, value]) => mocks.meta.set(key, value),
  transaction: fn => fn(),
}) }));
vi.mock("@/sse/local/quotaRouting.js", () => ({ loadCodexQuotaSnapshot: mocks.snapshot }));
vi.mock("@/lib/providerUsage.js", () => ({ loadConnectionUsage: mocks.usage, supportsConnectionUsage: () => true }));
vi.mock("@/lib/db/repos/usageRepo.js", () => ({ getActiveRequests: async () => ({ activeRequests: [] }) }));

import { buildCodexQuotaSummary } from "@/lib/local/codexQuotaSummary.js";
import { loadCodexQuotaSummary } from "@/lib/local/loadCodexQuotaSummary.js";
import { getCodexTotalQuotaAlerts, notifyCodexQuotaSummary } from "@/lib/alerts/codexQuota.js";
import { getAccountAlerts, notifyAccountUsage, checkAccountAlerts } from "@/lib/alerts/monitor.js";
import { notifyRequestError, queueAlert } from "@/lib/alerts/wecom.js";
import { ALERT_DEFAULTS } from "@/lib/alerts/config.js";
import { isCodexPoolQuotaLow } from "@/sse/local/quotaModelSwitch.js";

const config = { ...ALERT_DEFAULTS, enabled: true, webhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test", codexQuotaMode: "total" };
const account = (id, extra = {}) => ({ id, name: id, provider: "codex", authType: "oauth", isActive: true, ...extra });
const shared = account("shared");
const alice = account("alice-account", { exclusiveApiKeyIds: ["alice-key", "bob-key", "duplicate-key"] });
const bob = account("bob-account", { exclusiveApiKeyId: "bob-key" });
const usage = (session = 100, weekly = 100, plan = "plus") => ({ plan, quotas: {
  session: { used: 100 - session, total: 100, windowSeconds: 18000 },
  weekly: { used: 100 - weekly, total: 100, windowSeconds: 604800 },
} });
const summary = pairs => buildCodexQuotaSummary(pairs.map(([connection]) => connection), new Map(pairs.map(([connection, data]) => [connection.id, data])));
const payloads = () => mocks.fetch.mock.calls.map(([, init]) => JSON.parse(init.body));
async function flushAlerts() {
  await globalThis._codexTotalQuotaAlerts.pending;
  await globalThis._wecomAlerts.pending;
}

beforeEach(async () => {
  await flushAlerts();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  mocks.meta.clear();
  mocks.settings.mockResolvedValue({ wecomAlerts: config });
  mocks.connection.mockImplementation(async id => [shared, alice, bob].find(item => item.id === id));
  mocks.connections.mockResolvedValue([shared, alice, bob]);
  mocks.keys.mockResolvedValue([
    { id: "alice-key", name: "Alice.User", isActive: true },
    { id: "bob-key", name: "Bob.User", isActive: false },
    { id: "duplicate-key", name: "Alice.User", isActive: true },
  ]);
  mocks.snapshot.mockResolvedValue(usage());
  mocks.usage.mockResolvedValue(usage());
  mocks.fetch.mockImplementation(async () => {
    // Keep the sender's rate limiter out of these mocked transport tests.
    vi.setSystemTime(Date.now() + 5000);
    return { ok: true, json: async () => ({ errcode: 0 }) };
  });
});
afterEach(() => vi.useRealTimers());

describe("quota ownership summaries", () => {
  it("separates shared plans and individual dedicated accounts, including legacy bindings", () => {
    const result = summary([[shared, usage(80)], [alice, usage(0)], [bob, usage(20)]]);
    expect(result).toMatchObject({ accountCount: 3, sharedAccountCount: 1, dedicatedAccountCount: 2 });
    expect(result.groups).toHaveLength(3);
    expect(result.groups.find(group => group.scope === "shared")).toMatchObject({ accountCount: 1, session: { remainingPercent: 80 } });
    expect(result.groups.filter(group => group.scope === "dedicated").map(group => group.session.remainingPercent)).toEqual([0, 20]);
  });

  it("averages only shared accounts within each plan and excludes disabled accounts", () => {
    const result = summary([[shared, usage(0)], [account("shared-2"), usage(100)], [account("pro"), usage(25, 25, "pro")],
      [alice, usage(0)], [account("disabled", { isActive: false }), usage(0)]]);
    expect(result.sharedAccountCount).toBe(3);
    expect(result.groups.find(group => group.key === "shared:plus").session.remainingPercent).toBe(50);
    expect(result.groups.find(group => group.key === "shared:pro").session.remainingPercent).toBe(25);
  });

  it("keeps missing owners dedicated and restores sharing only after clearing bindings", () => {
    const missing = account("missing", { exclusiveApiKeyIds: ["deleted-key"] });
    expect(summary([[missing, usage()]]).sharedAccountCount).toBe(0);
    expect(summary([[{ ...missing, exclusiveApiKeyIds: [], exclusiveApiKeyId: "old-key" }, usage()]]).sharedAccountCount).toBe(1);
  });

  it("loads owner names without exposing credentials or API Key values", async () => {
    mocks.connections.mockResolvedValue([{ ...alice, accessToken: "private-token", refreshToken: "private-refresh" }]);
    const result = await loadCodexQuotaSummary({ force: true });
    expect(result.groups[0].exclusiveApiKeyNames).toEqual(["Alice.User", "Bob.User（已停用）", "Alice.User"]);
    expect(JSON.stringify(result)).not.toMatch(/private-token|private-refresh|accessToken/);
    expect(mocks.snapshot).toHaveBeenCalledWith(expect.any(Object), { force: true });
  });

  it("preserves model-switch calculations for the selected shared or dedicated pool", () => {
    const snapshots = new Map([[shared.id, usage(5)], [alice.id, usage(80)]]);
    const policy = { quotaModelSwitch: true, quotaUsedPercent: 90 };
    expect(isCodexPoolQuotaLow([shared], snapshots, policy)).toBe(true);
    expect(isCodexPoolQuotaLow([alice], snapshots, policy)).toBe(false);
  });
});

describe("isolated quota alerts", () => {
  it.each([
    [80, 0, "dedicated-quota:alice-account", "专用"],
    [0, 80, "shared-quota:plus", "共享"],
  ])("shared %s and dedicated %s trigger only the affected pool", (sharedRemaining, dedicatedRemaining, key, label) => {
    const alerts = getCodexTotalQuotaAlerts(summary([[shared, usage(sharedRemaining)], [alice, usage(dedicatedRemaining)]]), config);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].key).toContain(key);
    expect(alerts[0].content).toContain(label);
  });

  it("does not let unknown dedicated plans block shared or other dedicated alerts", () => {
    const alerts = getCodexTotalQuotaAlerts(summary([[shared, usage(0)], [alice, null], [bob, usage(0)]]), config);
    expect(alerts).toHaveLength(2);
    expect(alerts.map(item => item.groupKey)).toEqual(["shared:plus", "dedicated:bob-account"]);
  });

  it("keeps unknown shared plans from producing a misleading shared total", () => {
    const alerts = getCodexTotalQuotaAlerts(summary([[shared, usage(0)], [account("unknown"), null], [alice, usage(0)]]), config);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].connectionId).toBe(alice.id);
  });

  it("skips incomplete or expired windows while preserving other windows", () => {
    const incomplete = usage(0, 0);
    incomplete.quotas.session.resetAt = new Date(Date.now() - 1).toISOString();
    const alerts = getCodexTotalQuotaAlerts(summary([[shared, incomplete]]), config);
    expect(alerts[0].periods.map(item => item.period)).toEqual(["weekly"]);
  });

  it("only alerts weekly once when the session quota shares the weekly window", () => {
    const data = usage(0, 0);
    data.quotas.session.sharedWith = "weekly";
    const alerts = getCodexTotalQuotaAlerts(summary([[alice, data]]), config);
    expect(alerts[0].periods.map(item => item.period)).toEqual(["weekly"]);
  });

  it("mentions every bound UserID once, including disabled keys, without sharing recipients", async () => {
    await notifyCodexQuotaSummary(summary([[shared, usage(0, 0)], [alice, usage(0, 0)], [bob, usage(0, 0)]]), config);
    expect(payloads()).toHaveLength(3);
    expect(payloads()[0].text).not.toHaveProperty("mentioned_list");
    expect(payloads()[1].text.mentioned_list).toEqual(["Alice.User", "Bob.User"]);
    expect(payloads()[2].text.mentioned_list).toEqual(["Bob.User"]);
    expect(payloads()[1].text.content).toContain("额度归属：专用");
    await notifyCodexQuotaSummary(summary([[shared, usage(0, 0)], [alice, usage(0, 0)], [bob, usage(0, 0)]]), config);
    expect(payloads()).toHaveLength(3);
  });

  it("deduplicates periods independently and still alerts newly depleted quotas", async () => {
    await notifyCodexQuotaSummary(summary([[alice, usage(5, 80)]]), config);
    await notifyCodexQuotaSummary(summary([[alice, usage(5, 5)]]), config);
    await notifyCodexQuotaSummary(summary([[alice, usage(0, 5)]]), config);
    expect(payloads()).toHaveLength(3);
    expect(payloads()[1].text.content).not.toContain("5 小时额度");
    expect(payloads()[1].text.content).toContain("每周额度");
    expect(payloads()[2].text.content).toContain("已用尽");
  });

  it("does not claim successful delivery when WeCom fails", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error("network failure"));
    await notifyCodexQuotaSummary(summary([[alice, usage(0)]]), config);
    const record = JSON.parse(mocks.meta.get("wecomAlert:codex:dedicated-quota:alice-account:session:empty"));
    expect(record.sentAt).toBeUndefined();
    expect(record.failedAt).toBeGreaterThan(0);
  });

  it("checks dedicated accounts every monitor cycle in total mode", async () => {
    mocks.snapshot.mockImplementation(async connection => usage(connection.id === alice.id ? 0 : 100));
    await checkAccountAlerts();
    await flushAlerts();
    expect(mocks.usage).not.toHaveBeenCalled();
    expect(mocks.snapshot).toHaveBeenCalledTimes(3);
    expect(payloads()).toHaveLength(1);
    expect(payloads()[0].text.mentioned_list).toEqual(["Alice.User", "Bob.User"]);
  });

  it("reuses a dashboard quota response for immediate dedicated alerts in total mode", async () => {
    await notifyAccountUsage(alice, usage(0));
    await flushAlerts();
    expect(payloads()).toHaveLength(1);
    expect(payloads()[0].text.mentioned_list).toEqual(["Alice.User", "Bob.User"]);
    await notifyAccountUsage(shared, usage(0));
    await flushAlerts();
    expect(payloads()).toHaveLength(1);
  });

  it("preserves per-account mode and applies mentions to other providers", async () => {
    const connection = { ...alice, provider: "claude" };
    const alerts = getAccountAlerts(connection, usage(0), { ...config, codexQuotaMode: "account" });
    expect(alerts).toHaveLength(1);
    await queueAlert(alerts[0]);
    expect(payloads()[0].text.mentioned_list).toEqual(["Alice.User", "Bob.User"]);
  });

  it("never turns missing users or the reserved @all name into a broadcast", async () => {
    mocks.keys.mockResolvedValue([{ id: "alice-key", name: "@all", isActive: true }]);
    await notifyCodexQuotaSummary(summary([[alice, usage(0)]]), config);
    expect(payloads()[0].text).not.toHaveProperty("mentioned_list");
  });

  it("allows dedicated upstream 402 alerts while shared accounts use aggregate alerts", async () => {
    const entry = { source: "upstream", statusCode: 402, timestamp: new Date().toISOString() };
    await notifyRequestError({ ...entry, connectionId: shared.id });
    expect(payloads()).toHaveLength(0);
    await notifyRequestError({ ...entry, connectionId: alice.id });
    expect(payloads()).toHaveLength(1);
    expect(payloads()[0].text.mentioned_list).toEqual(["Alice.User", "Bob.User"]);
  });
});
