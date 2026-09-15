export const ALERT_DEFAULTS = {
  enabled: false,
  webhookUrl: "",
  quotaPercent: 10,
  balanceThreshold: 1,
  expiryDays: 3,
  cooldownMinutes: 10,
};
export const ALERT_POLL_MS = 5 * 60 * 1000;
export const ALERT_SEND_TIMEOUT_MS = 8000;
export const ALERT_USAGE_TIMEOUT_MS = 30000;
export const ALERT_DAILY_MS = 24 * 60 * 60 * 1000;

export function validateWebhook(value) {
  const url = new URL(value);
  if (url.origin !== "https://qyapi.weixin.qq.com" || url.pathname !== "/cgi-bin/webhook/send" ||
      url.username || url.password || url.hash || !url.searchParams.get("key") || [...url.searchParams.keys()].some(k => k !== "key")) {
    throw new Error("请填写有效的企业微信群机器人 Webhook");
  }
  return url.toString();
}

export function normalizeAlertConfig(input = {}, current = ALERT_DEFAULTS) {
  const result = { ...ALERT_DEFAULTS, ...current };
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new Error("告警开关无效");
    result.enabled = input.enabled;
  }
  if (input.webhookUrl?.trim()) result.webhookUrl = validateWebhook(input.webhookUrl.trim());
  for (const [key, min, max] of [["quotaPercent", 1, 99], ["balanceThreshold", 0, 10000], ["expiryDays", 1, 90], ["cooldownMinutes", 1, 1440]]) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "number" || !Number.isFinite(input[key]) || input[key] < min || input[key] > max) throw new Error("告警阈值超出范围");
    result[key] = input[key];
  }
  if (result.enabled && !result.webhookUrl) throw new Error("请先配置 Webhook");
  return result;
}

export function publicAlertConfig(config = {}) {
  const { webhookUrl, ...safe } = { ...ALERT_DEFAULTS, ...config };
  return { ...safe, configured: !!webhookUrl };
}
