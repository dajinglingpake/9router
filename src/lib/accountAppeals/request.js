import { randomBytes } from "node:crypto";
import { verifyDashboardAuthToken, shouldUseSecureCookie } from "@/lib/auth/dashboardSession";
import { getSettings } from "@/lib/localDb";
import { ownerFor, appealError } from "./sessions";

const OWNER_COOKIE = "9router_appeal_session";

export async function authorizeAppealRequest(request, mutation = false) {
  const token = request.cookies.get("auth_token")?.value;
  const authenticated = await verifyDashboardAuthToken(token);
  if (!authenticated && (await getSettings())?.requireLogin !== false) throw appealError("请先登录 9router 后再打开申诉窗口。", 401);
  if (mutation) {
    let origin;
    try { origin = new URL(request.headers.get("origin")); } catch { throw appealError("请求来源无效。", 403); }
    if (!["http:", "https:"].includes(origin.protocol) || origin.host !== request.headers.get("host")) throw appealError("请求来源无效。", 403);
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw appealError("请求必须使用 JSON。", 415);
  }
  return authenticated ? token : null;
}

export async function appealOwner(request, mutation = false, create = false) {
  const token = await authorizeAppealRequest(request, mutation);
  const authenticated = !!token;
  if (authenticated) return { owner: ownerFor(token) };
  const existing = request.cookies.get(OWNER_COOKIE)?.value;
  if (/^[a-f0-9]{64}$/.test(existing || "")) return { owner: ownerFor(`guest:${existing}`) };
  if (!mutation || !create) throw appealError("申诉窗口会话已失效，请重新打开。", 401);
  const value = randomBytes(32).toString("hex");
  const secure = shouldUseSecureCookie(request) || request.nextUrl?.protocol === "https:";
  return {
    owner: ownerFor(`guest:${value}`),
    cookie: `${OWNER_COOKIE}=${value}; Path=/api/account-appeals; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`,
  };
}

export const appealResponse = (data, status = 200, cookie) => Response.json(data, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...(cookie ? { "Set-Cookie": cookie } : {}) } });
export const appealFailure = error => appealResponse({ error: error.public ? error.message : "申诉窗口操作失败，请重试。" }, error.public ? error.status : 500);
