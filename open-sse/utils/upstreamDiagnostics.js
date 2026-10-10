import { DIAGNOSTIC_MAX_TEXT_LENGTH, DIAGNOSTIC_RESPONSE_HEADERS } from "../config/errorConfig.js";

// Only copy diagnostic headers; never log cookies, authorization or request bodies.
export function upstreamResponseDiagnostics(response) {
  const headers = {};
  for (const name of DIAGNOSTIC_RESPONSE_HEADERS) {
    const value = response?.headers?.get(name);
    if (value) headers[name] = safeDiagnosticMessage(value);
  }
  return { upstreamStatus: response?.status, headers };
}

export async function upstreamErrorMessage(response) {
  try {
    // Inspect a copy so the provider parser can still read the original body.
    const body = await response.clone().text();
    if (body.trim()) return safeDiagnosticMessage(body);
  } catch {
    // An unavailable body must not turn an upstream error into a network error.
  }
  return safeDiagnosticMessage(response.statusText || `HTTP ${response.status}`);
}

export function safeDiagnosticMessage(value) {
  return String(value || "").slice(0, DIAGNOSTIC_MAX_TEXT_LENGTH);
}

export function sseErrorDiagnostics(text) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      const event = JSON.parse(line.slice(5).trim());
      const error = event.error || event.response?.error || (event.type === "error" ? event : null);
      if (!error) continue;
      return Object.fromEntries(["code", "type", "message"].filter(key => typeof error[key] === "string")
        .map(key => [key, safeDiagnosticMessage(error[key])]));
    } catch { /* Ignore incomplete SSE frames. */ }
  }
  return null;
}
