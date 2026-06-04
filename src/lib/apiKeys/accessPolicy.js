function isValidIpv4(value) {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const number = Number(part);
    return number >= 0 && number <= 255 && String(number) === part.replace(/^0+(?=\d)/, "");
  });
}

function isValidIpv6(value) {
  if (!value.includes(":")) return false;
  try {
    new URL(`http://[${value}]/`);
    return true;
  } catch {
    return false;
  }
}

function isValidIp(value) {
  return isValidIpv4(value) || isValidIpv6(value);
}

function splitIpInput(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => (typeof item === "string" ? item.split(/[\s,;]+/) : [item]));
  }
  if (typeof value === "string") return value.split(/[\s,;]+/);
  return [value];
}

export function normalizeApiKeyName(name) {
  if (typeof name !== "string") return "";
  return name.trim().replace(/\s+/g, " ");
}

export function normalizeAllowedIps(value) {
  return Array.from(new Set(splitIpInput(value)
    .map((item) => (typeof item === "string" ? item.trim().toLowerCase() : ""))
    .filter((item) => item && isValidIp(item))));
}

export function parseAllowedIps(value) {
  if (Array.isArray(value)) return normalizeAllowedIps(value);
  if (typeof value !== "string" || !value.trim()) return [];
  return normalizeAllowedIps(value);
}

export function findInvalidAllowedIps(value) {
  return Array.from(new Set(splitIpInput(value)
    .map((item) => (typeof item === "string" ? item.trim().toLowerCase() : ""))
    .filter((item) => item && !isValidIp(item))));
}

export function serializeAllowedIps(value) {
  const ips = normalizeAllowedIps(value);
  return ips.length ? ips.join(",") : null;
}

export function mergeClaimAllowedIps(clientIp, requestedAllowedIps = []) {
  const normalizedClientIp = normalizeAllowedIps([clientIp])[0];
  if (!normalizedClientIp) return null;
  return normalizeAllowedIps([normalizedClientIp, ...parseAllowedIps(requestedAllowedIps)]);
}

export function isIpAllowed(allowedIps, clientIp) {
  const normalizedAllowedIps = parseAllowedIps(allowedIps);
  if (normalizedAllowedIps.length === 0) return true;
  const normalizedClientIp = normalizeAllowedIps([clientIp])[0] || "";
  return !!normalizedClientIp && normalizedAllowedIps.includes(normalizedClientIp);
}
