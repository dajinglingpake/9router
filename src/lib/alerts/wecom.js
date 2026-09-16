import { fetch as directFetch } from "undici";
import { getSettings } from "../db/repos/settingsRepo.js";
import { getAdapter } from "../db/driver.js";
import { getProviderConnectionById } from "../db/repos/connectionsRepo.js";
import { ALERT_DEFAULTS, ALERT_SEND_TIMEOUT_MS, validateWebhook } from "./config.js";

const state = globalThis._wecomAlerts ||= { pending: Promise.resolve(), queued: new Set() };
const STATUS_KEY = "wecomAlertStatus";

async function readState(key) {
  const db = await getAdapter();
  const row = db.get("SELECT value FROM _meta WHERE key = ?", [key]);
  return row ? JSON.parse(row.value) : {};
}
async function saveState(key, value) {
  const db = await getAdapter();
  db.run("INSERT INTO _meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, JSON.stringify(value)]);
}
export const getAlertStatus = () => readState(STATUS_KEY);

export async function sendWecomMessage(webhookUrl, content) {
  // Direct transport keeps the robot URL out of provider proxy logs and follows no redirects.
  const response = await directFetch(validateWebhook(webhookUrl), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(ALERT_SEND_TIMEOUT_MS),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msgtype: "text", text: { content: content.slice(0, 650) } }),
  });
  if (!response.ok) throw new Error(`企业微信 HTTP ${response.status}`);
  const result = await response.json();
  if (result.errcode !== 0) throw new Error(`企业微信错误码 ${Number(result.errcode) || "未知"}`);
}

export function queueAlert({ key, content, cooldownMs, test = false }) {
  if (state.queued.has(key)) return Promise.resolve(false);
  state.queued.add(key);
  const task = state.pending.then(async () => {
    const config = { ...ALERT_DEFAULTS, ...(await getSettings()).wecomAlerts };
    if (!test && !config.enabled) return false;
    const now = Date.now();
    const recordKey = `wecomAlert:${key}`;
    const previous = await readState(recordKey);
    if (now - (previous.sentAt || 0) < (cooldownMs ?? config.cooldownMinutes * 60000)) return false;
    if (now - (previous.failedAt || 0) < 60000) return false;
    // One serialized sender, at most one message every four seconds, including failures.
    const status = await getAlertStatus();
    const waitMs = Math.max(0, 4000 - (Date.now() - (status.lastAttemptAt || 0)));
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    const lastAttemptAt = Date.now();
    try {
      await sendWecomMessage(config.webhookUrl, content);
      await saveState(recordKey, { sentAt: lastAttemptAt });
      await saveState(STATUS_KEY, { lastAttemptAt, lastSentAt: lastAttemptAt, lastError: null });
      return true;
    } catch (error) {
      // Never persist fetch errors: they can contain the secret Webhook URL.
      const message = /^企业微信 (HTTP|错误码)/.test(error.message) ? error.message : "企业微信推送失败，请检查网络或机器人配置";
      await saveState(recordKey, { ...previous, failedAt: lastAttemptAt });
      await saveState(STATUS_KEY, { ...status, lastAttemptAt, lastError: message });
      if (test) throw new Error(message);
      console.warn("[Alerts]", message);
      return false;
    }
  }).finally(() => state.queued.delete(key));
  state.pending = task.catch(() => {});
  return task;
}

export async function notifyRequestError(entry) {
  if (!entry.connectionId || entry.transient || entry.recovered) return;
  const overloadTimeout = entry.source === "router" && entry.statusCode === 503
    && entry.retryCount > 0 && entry.timeoutRemainingMs === 0;
  if (!overloadTimeout && !(entry.source === "upstream" && [401, 402].includes(entry.statusCode))) return;
  const config = (await getSettings()).wecomAlerts;
  if (!config?.enabled) return;
  const connection = await getProviderConnectionById(entry.connectionId);
  if (!connection || connection.isActive === false) return;
  const kind = overloadTimeout ? "overload" : entry.statusCode === 402 ? "quota" : "auth";
  const label = { overload: "限流或过载", quota: "额度不足", auth: "账号凭证失效" }[kind];
  return queueAlert({
    key: `${connection.id}:${kind}`,
    content: `9router 告警｜${label}\n账号：${connection.name || connection.email || connection.id}\n提供商：${connection.provider}\n模型：${entry.model || "—"}\n状态：${entry.statusCode}\n${overloadTimeout ? "等待重试已超时，已向客户端返回 503。" : "请在运行状态的错误日志中查看详情。"}\n时间：${new Date(entry.timestamp).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
  });
}
