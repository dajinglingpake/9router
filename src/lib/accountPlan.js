import { decodeJwtPayload } from "./oauth/providerHelpers.js";
import { normalizeAccountPlanType, getAccountPlanLabel } from "@/shared/utils/accountPlan.js";

// Token claims describe the last issued credential, not live billing status.
export function getAccountPlan(connection) {
  if (connection?.provider !== "codex") return null;
  const claims = [connection.idToken, connection.accessToken].map(token => {
    const payload = decodeJwtPayload(token);
    const type = normalizeAccountPlanType(payload?.["https://api.openai.com/auth"]?.chatgpt_plan_type) || normalizeAccountPlanType(payload?.plan_type);
    const issuedAt = typeof payload?.iat === "number" && Number.isFinite(payload.iat) ? payload.iat * 1000 : null;
    const checkedAt = issuedAt !== null && Number.isFinite(new Date(issuedAt).getTime()) ? new Date(issuedAt).toISOString() : null;
    return type ? { type, checkedAt } : null;
  }).filter(Boolean).sort((a, b) => (Date.parse(b.checkedAt) || 0) - (Date.parse(a.checkedAt) || 0));
  const claim = claims[0];
  const type = claim?.type || normalizeAccountPlanType(connection.providerSpecificData?.chatgptPlanType);
  return { type: type || "unknown", label: getAccountPlanLabel(type), source: claim ? "credentials" : type ? "account" : null, checkedAt: claim?.checkedAt || null };
}
