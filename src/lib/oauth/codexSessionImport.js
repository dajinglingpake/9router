import { decodeJwtPayload } from "./providerHelpers.js";

// Map website sessions explicitly so unrelated session fields are not persisted.
export function normalizeCodexSession(raw) {
  if (!raw?.user || typeof raw.user !== "object") return raw;
  const item = { accessToken: raw.accessToken };
  if (typeof raw.user.email === "string") item.email = raw.user.email;
  const account = raw.account || {};
  item.providerSpecificData = {};
  if (typeof account.id === "string") item.providerSpecificData.chatgptAccountId = account.id;
  if (typeof account.planType === "string") item.providerSpecificData.chatgptPlanType = account.planType;

  // The access token can expire before the browser session does.
  const exp = decodeJwtPayload(item.accessToken)?.exp;
  const expires = typeof exp === "number" ? exp * 1000 : Date.parse(raw.expires);
  if (Number.isFinite(expires) && expires > 0 && expires <= 8640000000000000) {
    item.expiresAt = new Date(expires).toISOString();
  }
  return item;
}
