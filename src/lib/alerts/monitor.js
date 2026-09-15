import { getSettings } from "../db/repos/settingsRepo.js";
import { getProviderConnections, getProviderConnectionById } from "../db/repos/connectionsRepo.js";
import { getAdapter } from "../db/driver.js";
import { getAccountExpiry } from "../accountExpiry.js";
import { queueAlert } from "./wecom.js";
import { ALERT_DEFAULTS, ALERT_DAILY_MS, ALERT_POLL_MS, ALERT_USAGE_TIMEOUT_MS } from "./config.js";

const state = globalThis._wecomAlertMonitor ||= { timer: null, running: false };
const dateText = value => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
const quotaNames = { session: "5 小时额度", weekly: "每周额度", review_session: "审查额度（5 小时）", review_weekly: "审查额度（每周）", spark_session: "Spark 额度（5 小时）", spark_weekly: "Spark 额度（每周）" };

function codeBuddyAccountQuota(quotas, threshold, now) {
  const packs = Object.values(quotas).filter(quota => !(quota?.recurring === false && quota.resetAt && new Date(quota.resetAt).getTime() <= now));
  // Packages are alternate credit sources. Warn only when every usable pack is low.
  // An expired recurring snapshot or unknown balance cannot establish exhaustion.
  if (!packs.length || packs.some(quota => !quota || quota.unlimited ||
    !Number.isFinite(quota.used) || quota.used < 0 || !Number.isFinite(quota.total) || quota.total <= 0 ||
    (quota.resetAt && new Date(quota.resetAt).getTime() <= now) ||
    (quota.total - quota.used) / quota.total * 100 > threshold)) return {};
  const total = packs.reduce((sum, quota) => sum + quota.total, 0);
  const remaining = packs.reduce((sum, quota) => sum + Math.max(0, quota.total - quota.used), 0);
  return { "全部有效额度包": { used: total - remaining, total } };
}

export function getAccountAlerts(connection, usage, config, now = Date.now()) {
  const alerts = [];
  const account = `账号：${connection.name || connection.email || connection.id}\n提供商：${connection.provider}`;
  const low = [], empty = [];
  const quotas = connection.provider === "codebuddy-cn"
    ? codeBuddyAccountQuota(usage?.quotas || {}, config.quotaPercent, now) : usage?.quotas || {};
  for (const [name, quota] of Object.entries(quotas)) {
    if (!quota || (quota.resetAt && new Date(quota.resetAt).getTime() <= now)) continue;
    // DeepSeek reports current cash balance, not a percentage of purchased credit.
    if (connection.provider === "deepseek") {
      if (typeof quota.total === "number" && quota.total <= config.balanceThreshold) low.push(`${name}：余额 ${quota.total}`);
      continue;
    }
    if (quota.unlimited) continue;
    const percent = typeof quota.remainingPercentage === "number" ? quota.remainingPercentage
      : typeof quota.used === "number" && typeof quota.total === "number" && quota.total > 0
        ? (quota.total - quota.used) / quota.total * 100 : null;
    if (percent === null || !Number.isFinite(percent) || percent > config.quotaPercent) continue;
    const text = `${quotaNames[name] || name}：剩余 ${Math.max(0, percent).toFixed(1)}%${quota.resetAt ? `，恢复 ${dateText(quota.resetAt)}` : ""}`;
    (percent <= 0 ? empty : low).push(text);
  }
  if (low.length || empty.length) alerts.push({
    key: `${connection.id}:quota-${empty.length ? "empty" : "low"}`,
    cooldownMs: ALERT_DAILY_MS,
    content: `9router 告警｜${empty.length ? "额度已用尽" : "额度即将用尽"}\n${account}\n${[...empty, ...low].join("\n")}`,
  });
  const expiry = getAccountExpiry(connection);
  if (expiry && new Date(expiry.at).getTime() - now <= config.expiryDays * ALERT_DAILY_MS) {
    const expired = new Date(expiry.at).getTime() <= now;
    alerts.push({
      key: `${connection.id}:expiry-${expired ? "expired" : "soon"}`,
      cooldownMs: ALERT_DAILY_MS,
      content: `9router 告警｜${expiry.source === "subscription" && expired ? "订阅到期记录需核实" : expired ? "账号已到期" : "账号即将到期"}\n${account}\n到期：${dateText(expiry.at)}\n${expiry.source === "subscription" ? `来自订阅记录${expiry.checkedAt ? `，上次同步：${dateText(expiry.checkedAt)}` : ""}；如已续费，请刷新授权后核实。` : "来自手动设置的账号到期时间。"}`,
    });
  }
  return alerts;
}

// Reuse quota responses already requested by the dashboard.
export async function notifyAccountUsage(connection, usage) {
  if (connection.isActive === false) return;
  const config = { ...ALERT_DEFAULTS, ...(await getSettings()).wecomAlerts };
  if (!config.enabled || !config.webhookUrl) return;
  for (const alert of getAccountAlerts(connection, usage, config)) {
    void queueAlert(alert).catch(() => console.warn("[Alerts] Unable to queue account alert"));
  }
}

async function claimDailyQuotaCheck(connectionId) {
  const db = await getAdapter();
  let claimed = false;
  db.transaction(() => {
    const key = `wecomQuotaCheck:${connectionId}`;
    const previous = Number(db.get("SELECT value FROM _meta WHERE key = ?", [key])?.value);
    const now = Date.now();
    if (previous && now - previous < ALERT_DAILY_MS) return;
    // Persist before the call: failed queries and restarts must not cause frequent retries.
    db.run("INSERT INTO _meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, String(now)]);
    claimed = true;
  });
  return claimed;
}

export async function checkAccountAlerts() {
  if (state.running) return;
  state.running = true;
  try {
    const config = { ...ALERT_DEFAULTS, ...(await getSettings()).wecomAlerts };
    if (!config.enabled || !config.webhookUrl) return;
    const { loadConnectionUsage, supportsConnectionUsage } = await import("../providerUsage.js");
    for (let connection of await getProviderConnections({ isActive: true })) {
      let usage;
      if (supportsConnectionUsage(connection) && await claimDailyQuotaCheck(connection.id)) {
        try {
          usage = await loadConnectionUsage(connection, { signal: AbortSignal.timeout(ALERT_USAGE_TIMEOUT_MS) });
          connection = await getProviderConnectionById(connection.id) || connection;
        } catch {
          console.warn(`[Alerts] Daily quota check failed for ${connection.provider}`);
        }
      }
      // Expiry checks use local records, independent of the daily provider query.
      for (const alert of getAccountAlerts(connection, usage, config)) {
        void queueAlert(alert).catch(() => console.warn("[Alerts] Unable to queue account alert"));
      }
    }
  } catch {
    console.warn("[Alerts] Account check failed");
  } finally {
    state.running = false;
  }
}

export function startAlertMonitor() {
  if (state.timer || process.env.NEXT_PHASE === "phase-production-build") return;
  state.timer = setInterval(() => void checkAccountAlerts(), ALERT_POLL_MS);
  state.timer.unref?.();
  const startup = setTimeout(() => void checkAccountAlerts(), 15000);
  startup.unref?.();
}
