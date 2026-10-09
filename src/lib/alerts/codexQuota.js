import { getSettings } from "../db/repos/settingsRepo.js";
import { queueAlert } from "./wecom.js";
import { ALERT_DEFAULTS, ALERT_DAILY_MS } from "./config.js";
import { getAdapter } from "../db/driver.js";

const state = globalThis._codexTotalQuotaAlerts ||= { pending: Promise.resolve() };
const periodNames = { session: "5 小时额度", weekly: "每周额度" };

function combineAlerts(group, periods, config) {
  return {
    plan: group.plan,
    key: `codex:total-quota:${group.plan}:${periods.map(item => `${item.period}:${item.empty ? "empty" : "low"}`).join("+")}`,
    cooldownMs: ALERT_DAILY_MS,
    periods,
    content: [
      "9router 告警｜Codex 总额度告警",
      `套餐：${group.plan}`,
      `启用账号：${group.accountCount} 个`,
      ...periods.map(({ period, quota, empty }) => `${periodNames[period]}${empty ? "已用尽" : "即将用尽"}：剩余 ${quota.remainingPercent.toFixed(1)}%（约 ${quota.equivalentAccounts.toFixed(2)} / ${quota.accountCount} 个满额账号）`),
      `提醒阈值：剩余 ≤ ${config.quotaPercent}%`,
    ].join("\n"),
  };
}

export function getCodexTotalQuotaAlerts(summary, config) {
  // Failed reads with unknown plans cannot be assigned to a comparable pool.
  if (config.codexQuotaMode !== "total" || !summary.accountCount || summary.groups.some(group => group.plan === "unknown")) return [];
  return summary.groups.flatMap(group => {
    const periods = Object.keys(periodNames).flatMap(period => {
      const quota = group[period];
      if (period === "session" && group.sharedWeeklyAccounts === quota.accountCount) return [];
      if (!quota.accountCount || quota.knownAccounts !== quota.accountCount || quota.remainingPercent === null || quota.remainingPercent > config.quotaPercent) return [];
      const empty = quota.remainingPercent <= 0;
      return [{ period, quota, empty, key: `codex:total-quota:${group.plan}:${period}:${empty ? "empty" : "low"}` }];
    });
    return periods.length ? [combineAlerts(group, periods, config)] : [];
  });
}

export function notifyCodexQuotaSummary(summary, savedConfig) {
  // Serialize evaluation so overlapping checks cannot resend a period in another batch.
  const task = state.pending.then(async () => {
    const config = { ...ALERT_DEFAULTS, ...(savedConfig || (await getSettings()).wecomAlerts) };
    if (!config.enabled || !config.webhookUrl) return;
    const alerts = getCodexTotalQuotaAlerts(summary, config);
    if (!alerts.length) return;
    const db = await getAdapter();
    for (const alert of alerts) {
      const periods = alert.periods.filter(period => {
        const row = db.get("SELECT value FROM _meta WHERE key = ?", [`wecomAlert:${period.key}`]);
        const previous = row ? JSON.parse(row.value) : {};
        return Date.now() - (previous.sentAt || 0) >= ALERT_DAILY_MS;
      });
      if (!periods.length) continue;
      const group = summary.groups.find(item => item.plan === alert.plan);
      if (await queueAlert(combineAlerts(group, periods, config))) {
        const sentAt = Date.now();
        db.transaction(() => {
          for (const period of periods) db.run("INSERT INTO _meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [`wecomAlert:${period.key}`, JSON.stringify({ sentAt })]);
        });
      }
    }
  });
  state.pending = task.catch(() => {});
  return task;
}
