import { decodeJwtPayload } from "./providerHelpers.js";
import { parseChatgptSession } from "./chatgptSession.js";

// Map website sessions explicitly so unrelated session fields are not persisted.
export function normalizeCodexSession(raw) {
  if (typeof raw === "string") {
    const value = raw.trim();
    if (value.startsWith("{")) {
      try { raw = JSON.parse(value); } catch { throw Object.assign(new Error("Session JSON 格式无效。"), { status: 400 }); }
    } else raw = { accessToken: value };
  }
  let recorded;
  if (typeof raw?.sessionToken === "string" || typeof raw?.authProvider === "string") {
    const serialized = JSON.stringify(raw);
    parseChatgptSession(serialized);
    recorded = { raw: serialized, capturedAt: new Date().toISOString() };
  }
  if (!raw?.user || typeof raw.user !== "object") {
    if (raw && typeof raw === "object" && !Array.isArray(raw) && !raw.email) {
      const email = decodeJwtPayload(raw.accessToken)?.["https://api.openai.com/profile"]?.email;
      if (typeof email === "string") return { ...raw, email };
    }
    return raw;
  }
  const item = { accessToken: raw.accessToken };
  if (recorded) item.chatgptSession = recorded;
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
