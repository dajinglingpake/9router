// The gateway can refuse a request before Google sees it. A cached error on
// the account is not evidence about the model being probed.
export function describeGeminiProbeError(status, detail, source) {
  if (source !== "upstream") {
    return { testStatus: "retry", source: source === "client" ? "client" : "router",
      error: `HTTP ${status} · 网关未取得这个模型的 Google 响应，请稍后重试。` };
  }

  const raw = String(detail || "").replace(/^\[\d+\]:\s*/, "").split("\n提示：")[0];
  let google;
  try { google = JSON.parse(raw)?.error; } catch { /* Google can also return plain text. */ }
  const message = typeof google?.message === "string" ? google.message : raw;
  const violations = (Array.isArray(google?.details) ? google.details : []).flatMap(d => d?.violations || []);
  const quotaLines = status === 429 ? message.split("\n").filter(line => /\blimit\s*:/i.test(line)) : [];
  const zeroLine = quotaLines.find(line => /\blimit\s*:\s*0(?:[,\s]|$)/i.test(line));
  const zeroQuota = status === 429 && (Boolean(zeroLine) || violations.some(v => v?.quotaValue === "0" || v?.quotaValue === 0));
  const retry = status >= 500 || status === 408 || status === 499 || (status === 429 && !zeroQuota);
  let reason = "Google 拒绝了本次调用";
  if (status === 404 && /no longer available to new users/i.test(message)) reason = "Google 已停止向新用户提供此模型";
  else if (zeroQuota) reason = "Google 返回该调用的项目额度上限为 0";
  else if (status === 429) reason = "Google 暂时限流或本周期额度已用尽";
  else if (retry) reason = "Google 暂时无法完成请求";
  const summary = (zeroLine || quotaLines[0] || message)
    .replace(/\b(?:AIza|AQ\.|ya29\.|sk-)[\w.-]+/g, "[已隐藏]")
    .replace(/([?&](?:key|access_token)=)[^&\s]+/gi, "$1[已隐藏]")
    .replace(/\s+/g, " ").trim().slice(0, 350);
  return { testStatus: retry ? "retry" : "error", source, error: `HTTP ${status} · ${reason}。${summary}` };
}
