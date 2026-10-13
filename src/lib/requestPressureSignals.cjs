// Export categories only: upstream messages may contain request content.
function getRequestPressureSignal(entry = {}) {
  const message = [entry.upstreamErrorCode, entry.upstreamErrorType, entry.message].filter(Boolean).join(" ").toLowerCase();
  if (/context_length_exceeded|maximum context|context window|too many tokens|request.{0,20}too large/.test(message)) return "context";
  if (/usage.?limit|insufficient.?quota|quota.{0,30}(exceed|exhaust)|credit|billing|insufficient.{0,20}(balance|fund)/.test(message)) return "quota";
  if (/too.?many.?concurrent|concurrency.{0,30}(limit|exceed)|concurrent.{0,30}(limit|exceed)/.test(message)) return "concurrency";
  if (/\bserver_is_overloaded\b|\boverloaded\b/.test(message)) return "overload";
  if (/overload|high demand|server.{0,20}busy|capacity/.test(message)) return "busy";
  if (/rate.?limit|too many requests/.test(message)) return "rate-limit";
  if (/token.{0,20}(expired|revoked)|invalid.{0,20}(token|credential)|deactivated|authentication|unauthorized/.test(message)) return "credentials";
  if (/^(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|UND_ERR_[A-Z_]+)$/.test(entry.networkCode || "")) return "network";
  return "unknown";
}

module.exports = { getRequestPressureSignal };
