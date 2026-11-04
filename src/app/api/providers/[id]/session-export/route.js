import { getProviderConnectionById } from "@/models";
import { decodeJwtPayload } from "@/lib/oauth/providerHelpers";
import { refreshAndUpdateCredentials } from "@/lib/providerUsage";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const failure = (error, status) => Response.json({ error }, { status, headers });
const text = value => typeof value === "string" ? value.trim() : "";

export async function GET(_request, { params }) {
  try {
    const { id } = await params;
    let connection = await getProviderConnectionById(id);
    if (!connection) return failure("账号不存在，请刷新页面。", 404);
    if (connection.provider !== "codex" || !["oauth", "access_token"].includes(connection.authType)) {
      return failure("仅支持导出 Codex 账号的 Session。", 400);
    }
    if (!text(connection.accessToken)) return failure("账号没有登录凭证，请重新授权后下载。", 400);
    if (connection.refreshToken) {
      try {
        const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
        ({ connection } = await refreshAndUpdateCredentials(connection, false, {
          ...proxy, signal: AbortSignal.timeout(25000),
        }));
      } catch {
        return failure("登录凭证刷新失败，请重新授权后下载。", 401);
      }
    }

    const accessToken = text(connection.accessToken);
    if (!accessToken) return failure("账号没有登录凭证，请重新授权后下载。", 400);
    const access = decodeJwtPayload(accessToken) || {};
    const identity = decodeJwtPayload(connection.idToken) || {};
    const profile = access["https://api.openai.com/profile"] || {};
    const auth = access["https://api.openai.com/auth"] || identity["https://api.openai.com/auth"] || {};
    const data = connection.providerSpecificData || {};
    const expires = typeof access.exp === "number" ? access.exp * 1000 : Date.parse(connection.expiresAt || connection.tokenExpiresAt);
    if (Number.isFinite(expires) && expires <= Date.now()) {
      return failure("登录凭证已过期，请重新授权后下载。", 401);
    }

    // Export the available account fields from the existing OAuth credentials.
    const user = {};
    const userFields = {
      id: identity.sub || access.sub,
      email: connection.email || identity.email || profile.email || access.email,
      name: identity.name || profile.name,
      image: identity.picture || profile.picture,
    };
    for (const [key, value] of Object.entries(userFields)) {
      if (text(value)) user[key] = text(value);
    }
    const account = {};
    const accountId = text(data.workspaceId || data.accountId || data.chatgptAccountId || auth.chatgpt_account_id);
    const planType = text(data.chatgptPlanType || auth.chatgpt_plan_type);
    if (accountId) account.id = accountId;
    if (planType) account.planType = planType;
    const session = { user, account, accessToken };
    if (Number.isFinite(expires) && expires <= 8640000000000000) session.expires = new Date(expires).toISOString();
    const label = (user.email || connection.id).replace(/[^a-zA-Z0-9@._-]/g, "_").slice(0, 100);
    return new Response(`${JSON.stringify(session, null, 2)}\n`, {
      headers: {
        ...headers,
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="session-${label}.txt"`,
      },
    });
  } catch {
    return failure("Session 下载失败，请稍后重试。", 500);
  }
}
