function firstHeaderValue(value) {
  return value ? value.split(",")[0].trim() : "";
}

function normalizeClientIp(value) {
  if (!value || typeof value !== "string") return "";
  let ip = value.trim().replace(/^"|"$/g, "");

  if (ip.startsWith("[")) {
    const end = ip.indexOf("]");
    if (end > 0) ip = ip.slice(1, end);
  } else {
    const ipv4WithPort = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
    if (ipv4WithPort) ip = ipv4WithPort[1];
  }

  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return ip;
}

function parseForwardedFor(value) {
  if (!value) return "";
  const first = firstHeaderValue(value);
  const match = first.match(/(?:^|;)\s*for=([^;]+)/i);
  return match ? match[1].trim() : "";
}

export function extractClientIp(request) {
  const headers = request?.headers;
  if (!headers) return "unknown";

  const candidates = [
    headers.get("cf-connecting-ip"),
    headers.get("x-real-ip"),
    firstHeaderValue(headers.get("x-forwarded-for")),
    headers.get("x-client-ip"),
    parseForwardedFor(headers.get("forwarded")),
  ];

  for (const candidate of candidates) {
    const ip = normalizeClientIp(candidate);
    if (ip) return ip;
  }

  return normalizeClientIp(request.ip) || "unknown";
}
