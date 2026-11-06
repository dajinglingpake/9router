import { openMyAccountSession, getMyAccountKey, loadMyAccount } from "@/lib/myAccount.js";

export const dynamic = "force-dynamic";

function json(body, status = 200) {
  return Response.json(body, { status, headers: {
    "Cache-Control": "no-store, private",
    "Referrer-Policy": "no-referrer",
    "Vary": "Authorization",
  } });
}

export async function POST(request) {
  try {
    const session = await openMyAccountSession(request);
    return session ? json(session) : json({ error: "API Key 无效、已停用，或当前 IP 不在允许范围内。" }, 401);
  } catch {
    return json({ error: "暂时无法打开账号页面，请稍后重试。" }, 503);
  }
}

export async function GET(request) {
  try {
    const key = await getMyAccountKey(request);
    if (!key) return json({ error: "查看凭证已失效或当前 IP 不被允许，请从脚本重新打开。" }, 401);
    const summary = await loadMyAccount(key);
    // Recheck permission after slow upstream requests (key may have been revoked).
    if (!await getMyAccountKey(request)) return json({ error: "查看凭证已失效，请从脚本重新打开。" }, 401);
    return json(summary);
  } catch {
    return json({ error: "暂时无法查询账号，请稍后重试。" }, 503);
  }
}
