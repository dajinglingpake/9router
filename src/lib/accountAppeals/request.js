import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";
import { ownerFor, appealError } from "./sessions";

export async function appealOwner(request, mutation = false) {
  const token = request.cookies.get("auth_token")?.value;
  if (!await verifyDashboardAuthToken(token)) throw appealError("请先登录 9router 后再打开申诉窗口。", 401);
  if (mutation) {
    let origin;
    try { origin = new URL(request.headers.get("origin")); } catch { throw appealError("请求来源无效。", 403); }
    if (!["http:", "https:"].includes(origin.protocol) || origin.host !== request.headers.get("host")) throw appealError("请求来源无效。", 403);
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw appealError("请求必须使用 JSON。", 415);
  }
  return ownerFor(token);
}

export const appealResponse = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
export const appealFailure = error => appealResponse({ error: error.public ? error.message : "申诉窗口操作失败，请重试。" }, error.public ? error.status : 500);
