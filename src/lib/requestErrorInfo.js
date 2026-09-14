// Keep classification and readable descriptions shared by counts and details.
export function getRequestErrorInfo(entry) {
  const status = String(entry.status || "");
  const statusCode = Number(status.match(/\b([45]\d{2})\b/)?.[1]) || null;
  if (!statusCode && !/^(error|failed)\b/i.test(status)) return null;
  const source = entry.source || "upstream";
  if (statusCode === 499) return { category: "cancelled", summary: "请求已取消", statusCode };
  if (source === "router" && entry.message === "Concurrency queue wait timed out") {
    return { category: "server", summary: "服务端繁忙，排队等待超时", statusCode };
  }

  if (source === "client") {
    const reasons = {
      "Invalid JSON body": "请求内容格式不正确",
      "Missing model": "请求参数缺少模型",
      "Invalid model format": "请求的模型名称无效",
      "Missing API key": "未提供调用密钥",
      "Invalid API key": "调用密钥无效或已停用",
    };
    return { category: "client", summary: reasons[entry.message] || "调用方请求不符合要求", statusCode };
  }

  if (source === "upstream" && [400, 413, 422].includes(statusCode)) {
    return { category: "client", summary: statusCode === 413 ? "请求内容过大" : "请求参数不被上游接受", statusCode };
  }
  const reasons = source === "upstream" ? {
    401: "提供商账号凭证失效",
    402: "提供商账号余额或额度不足",
    403: "提供商账号无访问权限",
    404: "上游模型或服务不可用",
    429: "上游限流或账号额度不足",
    502: "上游连接失败或响应异常",
    503: "上游服务繁忙或暂不可用",
    504: "等待上游响应超时",
  } : {
    404: "未配置可用的提供商账号",
    429: "服务端繁忙，排队等待超时",
    503: "暂无可用的提供商账号",
  };
  return { category: "server", summary: reasons[statusCode] || "服务处理失败", statusCode };
}
