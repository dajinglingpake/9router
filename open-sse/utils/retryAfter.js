/**
 * Parse an HTTP Retry-After header into a delay in milliseconds.
 * Supports both delay-seconds and HTTP-date forms.
 */
export function parseRetryAfterMs(headers, now = Date.now()) {
  if (!headers?.get) return null;

  const raw = headers.get("retry-after");
  if (raw == null || String(raw).trim() === "") return null;

  const value = String(raw).trim();
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(timestamp - now, 0);
}
