import { fetch as directFetch } from "undici";
import { getSettings } from "../db/repos/settingsRepo.js";
import { getAdapter } from "../db/driver.js";
import { getApiKeys } from "../db/repos/apiKeysRepo.js";
import { getProviderConnectionById } from "../db/repos/connectionsRepo.js";
import { getConcurrencySnapshot } from "../../sse/services/concurrencyLimiter.js";
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
  const statusCode = Number(entry.statusCode);
  const overloadTimeout = entry.source === "router" && statusCode === 503
    && entry.timeoutRemainingMs === 0
    && (entry.retryCount > 0 || /账号繁忙|等待重试已超过时限|排队等待超时/.test(entry.message || ""));
  const networkFailure = entry.source !== "client" && [502, 504].includes(statusCode);
  if (!overloadTimeout && !networkFailure && !(entry.source === "upstream" && [401, 402].includes(statusCode))) return;
  const config = (await getSettings()).wecomAlerts;
  if (!config?.enabled) return;
  const connection = await getProviderConnectionById(entry.connectionId);
  if (!connection || connection.isActive === false) return;
  const kind = networkFailure ? "network" : overloadTimeout ? "overload" : statusCode === 402 ? "quota" : "auth";
  const label = {
    network: "上游网络连接失败",
    overload: "账号繁忙或等待超时",
    quota: "额度不足",
    auth: "账号凭证失效",
  }[kind];
  const metrics = await getRequestAlertMetrics();
  const reason = networkFailure
    ? `原因：${String(entry.message || "上游连接失败").slice(0, 160)}${entry.networkCode ? `（${entry.networkCode}）` : ""}`
    : overloadTimeout
      ? "原因：账号繁忙，等待重试已超过时限，请稍后重试。"
      : "请在运行状态的错误日志中查看详情。";
  const proxy = entry.proxyConfigured === false ? "未配置"
    : entry.proxyConfigured === true ? "已配置" : "未知";
  return queueAlert({
    key: `${connection.id}:${kind}`,
    content: [
      `9router 告警｜${label}`,
      `账号：${connection.name || connection.email || connection.id}`,
      `提供商：${connection.provider}`,
      `模型：${entry.model || "—"}`,
      `状态：${statusCode || entry.statusCode || "—"}`,
      `当前请求：${metrics.currentRequests} 个（活跃 ${metrics.activeRequests}，排队 ${metrics.queuedRequests}）`,
      `API Key：${metrics.activeApiKeys}/${metrics.apiKeys} 个启用`,
      `请求吞吐率：${metrics.throughputPerMinute} req/min（近 5 分钟）`,
      reason,
      ...(networkFailure ? [`代理：${proxy}`] : []),
      ...(overloadTimeout ? ["结果：已向客户端返回 503。"] : []),
      `时间：${new Date(entry.timestamp).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
    ].join("\n"),
  });
}

async function getRequestAlertMetrics() {
  const fallback = {
    currentRequests: "未知", activeRequests: "未知", queuedRequests: "未知",
    apiKeys: "未知", activeApiKeys: "未知", throughputPerMinute: "未知",
  };
  try {
    const db = await getAdapter();
    const [apiKeys, throughputRow, activeSnapshot] = await Promise.all([
      safeMetric(() => getApiKeys(), []),
      safeMetric(() => db.get(
        "SELECT COUNT(*) AS count FROM usageHistory WHERE timestamp >= ?",
        [new Date(Date.now() - 5 * 60 * 1000).toISOString()],
      ), { count: 0 }),
      (async () => {
        try {
          const { getActiveRequests } = await import("../db/repos/usageRepo.js");
          return await getActiveRequests();
        } catch {
          return null;
        }
      })(),
    ]);
    const pools = getConcurrencySnapshot();
    const queuedRequests = pools.reduce((sum, item) => sum + (Number(item.queued) || 0), 0);
    const trackedRequests = activeSnapshot?.activeRequests?.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
    const activeRequests = trackedRequests === undefined
      ? pools.reduce((sum, item) => sum + (Number(item.active) || 0), 0)
      : Math.max(0, trackedRequests - queuedRequests);
    const throughput = Math.round((Number(throughputRow?.count) || 0) / 5 * 10) / 10;
    return {
      currentRequests: trackedRequests ?? activeRequests + queuedRequests,
      activeRequests,
      queuedRequests,
      apiKeys: apiKeys.length,
      activeApiKeys: apiKeys.filter(key => key.isActive).length,
      throughputPerMinute: throughput,
    };
  } catch {
    return fallback;
  }
}

async function safeMetric(read, fallback) {
  try {
    return await read();
  } catch {
    return fallback;
  }
}
