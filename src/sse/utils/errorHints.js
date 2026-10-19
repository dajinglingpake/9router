import { getRequestPressureSignal } from "@/lib/requestPressureSignals.cjs";

const HINTS = {
  request: "请求参数或协议格式错误。",
  context: "请求上下文超出模型限制。",
  payload: "请求内容过大。",
  encoding: "请求内容编码或格式不受支持。",
  authentication: "身份验证失败，请检查调用密钥或账号登录状态。",
  credentials: "账号凭证无效或已失效。",
  permission: "访问权限不足或请求被策略拒绝。",
  disabled: "请求的模型或组合已禁用。",
  quota: "账号额度或余额不足。",
  "rate-limit": "请求频率受限。",
  concurrency: "并发请求数超过限制。",
  queue: "排队等待超时。",
  overload: "上游服务过载。",
  busy: "上游服务繁忙或模型容量不足。",
  timeout: "连接或响应超时。",
  network: "网络或代理连接失败。",
  gateway: "网关连接失败或上游响应异常。",
  account: "暂无可用账号。",
  binding: "当前会话的提供商绑定限制了本次请求。",
  missing: "请求的模型或接口不存在或不可用。",
  conflict: "请求状态冲突。",
  unavailable: "服务暂不可用。",
  resources: "服务端资源不足。",
  server: "服务端处理失败。",
  cancelled: "请求已取消。",
};

const RETRYABLE = new Set(["quota", "rate-limit", "concurrency", "queue", "overload", "busy", "timeout", "network", "gateway", "unavailable", "server"]);

function classifyError(status, message, { source, networkCode }) {
  if (source === "router") {
    if (/组合.+已禁用|模型.+已禁用/.test(message)) return "disabled";
    if (/已绑定其他提供商/.test(message)) return "binding";
    if (/暂无可用账号|账号已停用或删除|账号暂不可用/.test(message)) return "account";
  }
  if (/missing_required_parameter|missing required parameter|unsupported_parameter|unknown parameter/i.test(message)) return "request";
  if (/Concurrency queue wait timed out|等待重试已超过时限/i.test(message)) return "queue";
  if (status === 413) return "payload";
  if (status === 415) return "encoding";
  if (/invalid[ _]api[ _]key|missing[ _]api[ _]key/i.test(message)) return "authentication";
  if (/token_(expired|invalid|revoked)|refresh_token_reused/i.test(message)) return "credentials";

  const signal = getRequestPressureSignal({ message, networkCode });
  if (/额度已用尽|额度耗尽|余额不足/.test(message)) return "quota";
  if (signal !== "unknown" && signal !== "network") return signal;
  // Gateways can report connection timeouts as 503; do not call those overloads.
  if (/timeout|timed out|ETIMEDOUT|超时/i.test(`${networkCode || ""} ${message}`)) return "timeout";
  if (signal === "network" || /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_|fetch failed|connect error|connection reset|socket|proxy.*failed/i.test(message)) return "network";

  return {
    400: "request", 401: "authentication", 402: "quota", 403: "permission",
    404: "missing", 408: "timeout", 409: "conflict", 422: "request",
    429: "rate-limit", 499: "cancelled", 502: "gateway", 503: "unavailable", 504: "timeout", 507: "resources",
  }[status] || (status >= 500 ? "server" : null);
}

export function appendChatErrorHint(status, message, options = {}) {
  const category = classifyError(Number(status), message || "", options);
  if (!message || !HINTS[category]) return message;
  const seconds = Number(options.retryAfterSeconds);
  const wait = RETRYABLE.has(category) && Number.isFinite(seconds) && seconds > 0
    ? ` 请在 ${Math.ceil(seconds)} 秒后重试。` : "";
  // Keep the original error verbatim; only append a separate explanation.
  return `${message}\n提示：${HINTS[category]}${wait}`;
}
