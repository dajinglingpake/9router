import { decodeJwtPayload } from "./oauth/providerHelpers.js";

function isoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// OAuth token expiry is not subscription expiry. Claims are a snapshot, not live billing data.
export function getAccountExpiry(connection) {
  const manual = isoDate(connection.accountExpiresAt);
  if (manual) return { at: manual, source: "manual", checkedAt: null };
  if (connection.provider !== "codex") return null;
  const auth = decodeJwtPayload(connection.idToken)?.["https://api.openai.com/auth"];
  const at = isoDate(auth?.chatgpt_subscription_active_until);
  return at ? { at, source: "subscription", checkedAt: isoDate(auth.chatgpt_subscription_last_checked) } : null;
}
