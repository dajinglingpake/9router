import { beforeEach, afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSqlJsAdapter } from "../../src/lib/db/adapters/sqljsAdapter.js";

const mocks = vi.hoisted(() => ({ db: null, settings: {}, fetch: vi.fn(), connection: { id: "a", provider: "codex", name: "Account A" } }));
vi.mock("undici", () => ({ fetch: mocks.fetch }));
vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: async () => mocks.db }));
vi.mock("../../src/lib/db/repos/settingsRepo.js", () => ({ getSettings: async () => mocks.settings, updateSettings: async value => Object.assign(mocks.settings, value) }));
vi.mock("../../src/lib/db/repos/connectionsRepo.js", () => ({ getProviderConnectionById: async () => mocks.connection, getProviderConnections: async () => [mocks.connection] }));
vi.mock("../../src/lib/providerUsage.js", () => ({ supportsConnectionUsage: () => true, loadConnectionUsage: async () => ({ quotas: { session: { used: 95, total: 100 } } }) }));
import { ALERT_DEFAULTS, normalizeAlertConfig, publicAlertConfig } from "../../src/lib/alerts/config.js";
import { queueAlert, notifyRequestError, sendWecomMessage, getAlertStatus } from "../../src/lib/alerts/wecom.js";
import { getAccountAlerts, checkAccountAlerts } from "../../src/lib/alerts/monitor.js";
import { getAccountExpiry } from "../../src/lib/accountExpiry.js";
import { GET, PATCH, POST } from "../../src/app/api/settings/alerts/route.js";

const webhookUrl = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-only";
const jwt = auth => `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": auth })).toString("base64url")}.signature`;
let now, tempDir;
beforeEach(async () => {
  vi.useFakeTimers();
  now = new Date("2026-09-15T00:00:00Z").getTime();
  vi.setSystemTime(now);
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-alerts-"));
  mocks.db = await createSqlJsAdapter(path.join(tempDir, "test.sqlite"));
  mocks.db.exec("CREATE TABLE _meta(key TEXT PRIMARY KEY, value TEXT)");
  mocks.settings = { wecomAlerts: { ...ALERT_DEFAULTS, enabled: true, webhookUrl } };
  mocks.connection = { id: "a", provider: "codex", name: "Account A" };
  mocks.fetch.mockReset().mockResolvedValue({ ok: true, json: async () => ({ errcode: 0 }) });
});
afterEach(async () => {
  await vi.runAllTimersAsync();
  await globalThis._wecomAlerts.pending;
  mocks.db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.useRealTimers();
});

it("validates and masks the Webhook without replacing it on an empty edit", () => {
  expect(normalizeAlertConfig({ webhookUrl: "" }, mocks.settings.wecomAlerts).webhookUrl).toBe(webhookUrl);
  expect(publicAlertConfig(mocks.settings.wecomAlerts)).not.toHaveProperty("webhookUrl");
  for (const url of ["http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x", "https://evil.example/?key=x", "https://qyapi.weixin.qq.com.evil.example/?key=x", "https://qyapi.weixin.qq.com/cgi-bin/webhook/send"]) {
    expect(() => normalizeAlertConfig({ webhookUrl: url })).toThrow();
  }
  expect(() => normalizeAlertConfig({ quotaPercent: -1 })).toThrow();
});

it("coalesces concurrent overloads across models and persists the cooldown", async () => {
  const error = { connectionId: "a", source: "upstream", statusCode: 503, transient: true, timestamp: now };
  await Promise.all([notifyRequestError({ ...error, model: "sol" }), notifyRequestError({ ...error, model: "astra" })]);
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  const stored = mocks.db.get("SELECT value FROM _meta WHERE key = ?", ["wecomAlert:a:overload"]);
  expect(JSON.parse(stored.value).sentAt).toBe(now);
  // A fresh module uses the persisted delivery timestamp too.
  vi.resetModules();
  const fresh = await import("../../src/lib/alerts/wecom.js");
  vi.setSystemTime(now + 599000);
  expect(await fresh.queueAlert({ key: "a:overload", content: "duplicate" })).toBe(false);
  vi.setSystemTime(now + 601000);
  expect(await fresh.queueAlert({ key: "a:overload", content: "again" })).toBe(true);
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
});

it("spaces different account messages and ignores caller errors", async () => {
  await notifyRequestError({ connectionId: "a", source: "client", statusCode: 429 });
  expect(mocks.fetch).not.toHaveBeenCalled();
  await queueAlert({ key: "a:overload", content: "a" });
  const next = queueAlert({ key: "b:overload", content: "b" });
  await vi.advanceTimersByTimeAsync(3999);
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await next;
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
});

it("records sanitized failures and permits another attempt after one minute", async () => {
  mocks.fetch.mockRejectedValueOnce(new Error(`fetch failed ${webhookUrl}`));
  expect(await queueAlert({ key: "a:overload", content: "x" })).toBe(false);
  expect(JSON.stringify(await getAlertStatus())).not.toContain("test-only");
  expect(await queueAlert({ key: "a:overload", content: "x" })).toBe(false);
  vi.setSystemTime(now + 61000);
  expect(await queueAlert({ key: "a:overload", content: "x" })).toBe(true);
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
});

it("requires the robot business success code even on HTTP 200", async () => {
  mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ errcode: 93000, errmsg: "private" }) });
  await expect(sendWecomMessage(webhookUrl, "test")).rejects.toThrow("93000");
  const options = mocks.fetch.mock.calls[0][1];
  expect(options.redirect).toBe("error");
  expect(JSON.parse(options.body)).toEqual({ msgtype: "text", text: { content: "test" } });
});

it("does not treat auto-refreshing token expiry as account expiry", () => {
  expect(getAccountExpiry({ ...mocks.connection, expiresAt: "2026-09-16" })).toBeNull();
  const c = { ...mocks.connection, idToken: jwt({ chatgpt_subscription_active_until: "2026-09-16T00:00:00Z", chatgpt_subscription_last_checked: "2026-09-10T00:00:00Z" }) };
  expect(getAccountExpiry(c)).toMatchObject({ source: "subscription", at: "2026-09-16T00:00:00.000Z" });
  expect(getAccountExpiry({ ...c, accountExpiresAt: "2026-10-01" }).source).toBe("manual");
  const alerts = getAccountAlerts(c, {}, ALERT_DEFAULTS, now);
  expect(alerts[0].content).toContain("上次同步");
});

it("detects low and depleted quotas without alerting unlimited, unknown or already-reset windows", () => {
  const quotas = { session: { used: 95, total: 100 }, weekly: { used: 100, total: 100 }, unlimited: { used: 100, total: 100, unlimited: true }, unknown: {}, old: { used: 100, total: 100, resetAt: "2026-09-14" } };
  const result = getAccountAlerts(mocks.connection, { quotas }, ALERT_DEFAULTS, now);
  expect(result).toHaveLength(1);
  expect(result[0].content).toContain("额度已用尽");
  expect(result[0].content).toContain("5.0%");
  expect(result[0].content).not.toContain("old");
  expect(result[0].content).not.toContain("unlimited");
  const balance = getAccountAlerts({ ...mocks.connection, provider: "deepseek" }, { quotas: { "Balance (CNY)": { total: 0.5, unlimited: true } } }, ALERT_DEFAULTS, now);
  expect(balance[0].content).toContain("余额 0.5");
});

it("alerts on CodeBuddy only when all valid packs are low or depleted", () => {
  const connection = { ...mocks.connection, provider: "codebuddy-cn" };
  const usage = { quotas: { gift: { used: 10000, total: 10000 }, paid: { used: 10, total: 100 } } };
  expect(getAccountAlerts(connection, usage, ALERT_DEFAULTS, now)).toEqual([]);
  usage.quotas.paid.used = 95;
  const low = getAccountAlerts(connection, usage, ALERT_DEFAULTS, now);
  expect(low).toHaveLength(1);
  expect(low[0].content).toContain("额度即将用尽");
  expect(low[0].content).toContain("全部有效额度包");
  usage.quotas.paid.used = 100;
  expect(getAccountAlerts(connection, usage, ALERT_DEFAULTS, now)[0].content).toContain("额度已用尽");
  usage.quotas.paid.used = 10;
  const alerts = getAccountAlerts({ ...connection, accountExpiresAt: "2026-09-16" }, usage, ALERT_DEFAULTS, now);
  expect(alerts).toHaveLength(1);
  expect(alerts[0].content).toContain("账号即将到期");
});

it("ignores expired CodeBuddy bonuses and never assumes stale or unknown packs are exhausted", () => {
  const connection = { ...mocks.connection, provider: "codebuddy-cn" };
  const depleted = { used: 100, total: 100 };
  const oldBonus = { used: 0, total: 10000, recurring: false, resetAt: "2026-09-14" };
  expect(getAccountAlerts(connection, { quotas: { depleted, oldBonus } }, ALERT_DEFAULTS, now)[0].content).toContain("额度已用尽");
  for (const unknown of [{}, { used: 0, total: 0 }, { used: 100, total: 100, unlimited: true }, { ...depleted, recurring: true, resetAt: "2026-09-14" }]) {
    expect(getAccountAlerts(connection, { quotas: { depleted, unknown } }, ALERT_DEFAULTS, now)).toEqual([]);
  }
});

it("polls quota without a browser and stops when alerts are disabled", async () => {
  await checkAccountAlerts();
  await globalThis._wecomAlerts.pending;
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  mocks.settings.wecomAlerts.enabled = false;
  vi.setSystemTime(now + 86401000);
  await checkAccountAlerts();
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});

it("never exposes the configured secret through settings and limits test pushes", async () => {
  const data = await (await GET()).json();
  expect(data.configured).toBe(true);
  expect(JSON.stringify(data)).not.toContain("test-only");
  mocks.settings.wecomAlerts.enabled = false;
  const request = value => new Request("http://localhost/api/settings/alerts", { method: "PATCH", body: JSON.stringify(value) });
  expect((await PATCH(request({ quotaPercent: 20, webhookUrl: "" }))).status).toBe(200);
  expect(mocks.settings.wecomAlerts.webhookUrl).toBe(webhookUrl);
  expect((await POST()).status).toBe(200);
  expect((await POST()).status).toBe(200);
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});
