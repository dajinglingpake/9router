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
  vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
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
    data.quotas.session.resetAt = data.quotas.weekly.resetAt = "2030-01-07T20:45:00Z";
    const alerts = getCodexTotalQuotaAlerts(summary([[alice, data]]), config);
    expect(alerts[0].periods.map(item => item.period)).toEqual(["weekly"]);
    expect(alerts[0].content).not.toContain("5 小时额度");
    expect(alerts[0].content.match(/重置时间/g)).toHaveLength(1);
    expect(alerts[0].content).toContain("每周额度重置时间：2030/1/8 04:45:00（北京时间）");
  });

  it("mentions every bound UserID once, including disabled keys, without sharing recipients", async () => {
    await notifyCodexQuotaSummary(summary([[shared, usage(0, 0)], [alice, usage(0, 0)], [bob, usage(0, 0)]]), config);
    expect(payloads()).toHaveLength(3);
    expect(payloads()[0].text).not.toHaveProperty("mentioned_list");
    expect(payloads()[1].text.mentioned_list).toEqual(["Alice.User", "Bob.User"]);
    expect(payloads()[2].text.mentioned_list).toEqual(["Bob.User"]);
    expect(payloads()[0].text.content).not.toContain("@Alice.User");
    expect(payloads()[1].text.content).toContain("额度归属：专用（@Alice.User、@Bob.User）");
    expect(payloads()[1].text.content).not.toContain("自动切换");
    await notifyCodexQuotaSummary(summary([[shared, usage(0, 0)], [alice, usage(0, 0)], [bob, usage(0, 0)]]), config);
    expect(payloads()).toHaveLength(3);
  });

  it("shows the confirmed Chinese UserID with @ while sending the unprefixed recipient ID", async () => {
    mocks.keys.mockResolvedValue([
      { id: "alice-key", name: " 陶俊帆 " },
      { id: "duplicate-key", name: "陶俊帆" },
    ]);
    await notifyCodexQuotaSummary(summary([[alice, usage(10)]]), config);
    expect(payloads()[0].text.mentioned_list).toEqual(["陶俊帆"]);
    expect(payloads()[0].text.content).toContain("额度归属：专用（@陶俊帆）");
  });

  it("sends separate session and weekly reset times in Beijing time with mentions and the model target", async () => {
    mocks.settings.mockResolvedValue({ wecomAlerts: config, localCodexRouting: { quotaModelSwitch: true } });
    mocks.keys.mockResolvedValue([{ id: "alice-key", name: "陶俊帆" }]);
    const data = usage(10, 0);
    data.quotas.session.resetAt = "2030-01-01T18:30:00Z";
    data.quotas.weekly.resetAt = "2030-01-07T20:45:00Z";
    await notifyCodexQuotaSummary(summary([[alice, data]]), config);
    const payload = payloads()[0].text;
    expect(payload.mentioned_list).toEqual(["陶俊帆"]);
    expect(payload.content).toContain("额度归属：专用（@陶俊帆）");
    expect(payload.content).toContain("自动切换模型：gpt-6-luna");
    expect(payload.content).toContain("5 小时额度重置时间：2030/1/2 02:30:00（北京时间）");
    expect(payload.content).toContain("每周额度重置时间：2030/1/8 04:45:00（北京时间）");
    expect(payload.content).toContain("提醒阈值");
    expect(Buffer.byteLength(payload.content, "utf8")).toBeLessThanOrEqual(2048);
  });

  it("reports the earliest and latest shared reset without including dedicated or disabled accounts", () => {
    const first = usage(5), last = usage(5), dedicated = usage(5);
    first.quotas.session.resetAt = "2030-01-02T08:00:00+08:00";
    last.quotas.session.resetAt = "2030-01-02T03:00:00Z";
    dedicated.quotas.session.resetAt = "2030-01-01T00:00:00Z";
    const result = summary([[shared, last], [account("shared-2"), first], [alice, dedicated],
      [account("disabled", { isActive: false }), dedicated]]);
    expect(result.groups.find(group => group.scope === "shared").session).toMatchObject({
      accountCount: 2, knownResetAccounts: 2,
      earliestResetAt: "2030-01-02T00:00:00.000Z", latestResetAt: "2030-01-02T03:00:00.000Z",
    });
    const alert = getCodexTotalQuotaAlerts(result, config).find(item => !item.connectionId);
    expect(alert.content).toContain("5 小时额度重置时间：最早 2030/1/2 08:00:00，最晚 2030/1/2 11:00:00（北京时间）");
    expect(alert.content).not.toContain("2030/1/1");
  });

  it("shows one reset time when every shared account resets together", () => {
    const data = usage(10);
    data.quotas.session.resetAt = "2030-01-02T00:00:00Z";
    const result = summary([[shared, data], [account("shared-2"), data]]);
    expect(result.groups[0].session.knownResetAccounts).toBe(2);
    const [alert] = getCodexTotalQuotaAlerts(result, config);
    expect(alert.content).toContain("重置时间：2030/1/2 08:00:00（北京时间）");
    expect(alert.content).not.toMatch(/最早|最晚|未知/);
  });

  it.each([undefined, null, "invalid-date"])("marks unavailable reset time %s as unknown without suppressing the quota alert", resetAt => {
    const data = usage(0);
    data.quotas.session.resetAt = resetAt;
    const result = summary([[alice, data]]);
    expect(result.groups[0].session).toMatchObject({ knownResetAccounts: 0, earliestResetAt: null, latestResetAt: null });
    const [alert] = getCodexTotalQuotaAlerts(result, config);
    expect(alert.content).toContain("5 小时额度重置时间：未知（上游未提供有效时间）");
    expect(alert.content).not.toMatch(/Invalid Date|1970/);
  });

  it("labels incomplete shared reset information as known times with the missing account count", () => {
    const data = usage(5);
    data.quotas.session.resetAt = "2030-01-02T00:00:00Z";
    const [alert] = getCodexTotalQuotaAlerts(summary([[shared, data], [account("shared-2"), usage(5)]]), config);
    expect(alert.content).toContain("5 小时额度已知重置时间：2030/1/2 08:00:00（北京时间）；另 1 个账号重置时间未知");
  });

  it("drops expired reset times and sends only the remaining applicable weekly reset", () => {
    const data = usage(0, 0);
    data.quotas.session.resetAt = new Date(Date.now() - 1000).toISOString();
    data.quotas.weekly.resetAt = "2030-01-07T20:45:00Z";
    const result = summary([[alice, data]]);
    expect(result.groups[0].session.knownResetAccounts).toBe(0);
    const [alert] = getCodexTotalQuotaAlerts(result, config);
    expect(alert.content).not.toContain("5 小时额度");
    expect(alert.content).toContain("每周额度重置时间：2030/1/8 04:45:00（北京时间）");
  });

  it("includes the saved model and routing threshold for both shared and dedicated quota alerts", async () => {
    mocks.settings.mockResolvedValue({ wecomAlerts: config, localCodexRouting: {
      quotaModelSwitch: true, quotaFallbackModel: "gpt-6-luna", quotaUsedPercent: 95,
    } });
    await notifyCodexQuotaSummary(summary([[shared, usage(5)], [alice, usage(5)]]), config);
    expect(payloads()).toHaveLength(2);
    for (const payload of payloads()) {
      expect(payload.text.content).toContain("自动切换模型：gpt-6-luna（已用 ≥ 95%");
      expect(payload.text.content).toContain("额度未耗尽且模型权限允许时生效");
    }
    expect(payloads()[0].text).not.toHaveProperty("mentioned_list");
  });

  it("omits model switching when disabled even if a target is configured", async () => {
    mocks.settings.mockResolvedValue({ wecomAlerts: config, localCodexRouting: {
      quotaModelSwitch: false, quotaFallbackModel: "gpt-6-luna",
    } });
    await notifyCodexQuotaSummary(summary([[alice, usage(10)]]), config);
    expect(payloads()[0].text.content).not.toContain("自动切换");
    expect(payloads()[0].text.content).not.toContain("gpt-6-luna");
  });

  it("preserves recipient and model details when per-account quota text is truncated", async () => {
    mocks.settings.mockResolvedValue({ wecomAlerts: config, localCodexRouting: {
      quotaModelSwitch: true, quotaFallbackModel: "configured-model",
    } });
    const alerts = getAccountAlerts(alice, usage(10), { ...config, codexQuotaMode: "account" });
    await queueAlert({ ...alerts[0], content: alerts[0].content + "\n" + "额度详情".repeat(200) });
    expect(payloads()[0].text.content).toHaveLength(650);
    expect(payloads()[0].text.content).toContain("额度归属：专用（@Alice.User、@Bob.User）");
    expect(payloads()[0].text.content).toContain("自动切换模型：configured-model");
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
    mocks.settings.mockResolvedValue({ wecomAlerts: config, localCodexRouting: { quotaModelSwitch: true } });
    const connection = { ...alice, provider: "claude" };
    const alerts = getAccountAlerts(connection, usage(0), { ...config, codexQuotaMode: "account" });
    expect(alerts).toHaveLength(1);
    await queueAlert(alerts[0]);
    expect(payloads()[0].text.mentioned_list).toEqual(["Alice.User", "Bob.User"]);
    expect(payloads()[0].text.content).not.toContain("自动切换");
  });

  it("never turns missing users or the reserved @all name into a broadcast", async () => {
    mocks.keys.mockResolvedValue([{ id: "alice-key", name: "@all", isActive: true }]);
    await notifyCodexQuotaSummary(summary([[alice, usage(0)]]), config);
    expect(payloads()[0].text).not.toHaveProperty("mentioned_list");
  });

  it("allows dedicated upstream 402 alerts while shared accounts use aggregate alerts", async () => {
    mocks.settings.mockResolvedValue({ wecomAlerts: config, localCodexRouting: {
      quotaModelSwitch: true, quotaFallbackModel: "gpt-6-luna",
    } });
    const entry = { source: "upstream", statusCode: 402, timestamp: new Date().toISOString() };
    await notifyRequestError({ ...entry, connectionId: shared.id });
    expect(payloads()).toHaveLength(0);
    await notifyRequestError({ ...entry, connectionId: alice.id });
    expect(payloads()).toHaveLength(1);
    expect(payloads()[0].text.mentioned_list).toEqual(["Alice.User", "Bob.User"]);
    expect(payloads()[0].text.content).toContain("自动切换模型：gpt-6-luna");
  });
});
