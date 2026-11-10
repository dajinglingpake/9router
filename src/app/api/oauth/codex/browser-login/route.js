import { createHash, randomBytes } from "node:crypto";
import { verifyDashboardAuthToken, shouldUseSecureCookie } from "@/lib/auth/dashboardSession";
import { getSettings } from "@/lib/localDb";
import { startCodexBrowserLogin, codexBrowserLoginFrame, codexBrowserLoginAction } from "@/lib/oauth/codexBrowserLogin";
import { chatgptSessionError } from "@/lib/oauth/chatgptSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const COOKIE = "9router_codex_browser_login";
const response = (body, status = 200, cookie) => Response.json(body, { status, headers: { ...headers, ...(cookie ? { "Set-Cookie": cookie } : {}) } });
const failure = error => response({ error: error.status ? error.message : "网页登录操作失败，请稍后重试。" }, error.status || 500);

async function ownerFor(request, create = false) {
  const token = request.cookies.get("auth_token")?.value;
  if (await verifyDashboardAuthToken(token)) return { owner: createHash("sha256").update(token).digest("hex") };
  if ((await getSettings())?.requireLogin !== false) throw chatgptSessionError("请先登录 9Router。", 401);
  let cookie = request.cookies.get(COOKIE)?.value;
  const exists = /^[a-f0-9]{64}$/.test(cookie || "");
  if (!exists && !create) throw chatgptSessionError("登录窗口已失效，请重新打开。", 401);
  if (!exists) cookie = randomBytes(32).toString("hex");
  return {
    owner: createHash("sha256").update(`guest:${cookie}`).digest("hex"),
    ...(!exists ? { cookie: `${COOKIE}=${cookie}; Path=/api/oauth/codex/browser-login; HttpOnly; SameSite=Strict${shouldUseSecureCookie(request) || request.nextUrl?.protocol === "https:" ? "; Secure" : ""}` } : {}),
  };
}

export async function POST(request) {
  try {
    let origin;
    try { origin = new URL(request.headers.get("origin")); } catch { throw chatgptSessionError("请求来源无效。", 403); }
    if (!["http:", "https:"].includes(origin.protocol) || origin.host !== request.headers.get("host")) throw chatgptSessionError("请求来源无效。", 403);
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw chatgptSessionError("请求必须使用 JSON。", 415);
    let body;
    try { body = await request.json(); } catch { throw chatgptSessionError("请求不是有效 JSON。", 400); }
    const { owner, cookie } = await ownerFor(request, body?.type === "start");
    if (body?.type === "start") {
      return response(await startCodexBrowserLogin(body.connectionId, owner, body.requestId, Number(new URL(request.url).port) || 20128), 202, cookie);
    }
    return response(await codexBrowserLoginAction(body?.id, owner, body));
  } catch (error) { return failure(error); }
}

export async function GET(request) {
  try {
    const { owner } = await ownerFor(request);
    return response(await codexBrowserLoginFrame(request.nextUrl.searchParams.get("id"), owner, request.nextUrl.searchParams.get("frame") !== "0"));
  } catch (error) { return failure(error); }
}
