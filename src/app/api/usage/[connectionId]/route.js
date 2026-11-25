import { getProviderConnectionById } from "@/lib/localDb";
import { loadConnectionUsage } from "@/lib/providerUsage";
import { notifyAccountUsage } from "@/lib/alerts/monitor";
import { parseGeminiQuota } from "@/lib/geminiUsage";
import { setGeminiModelQuota } from "@/lib/db/repos/connectionsRepo";

export { refreshAndUpdateCredentials } from "@/lib/providerUsage";

export async function PATCH(request, { params }) {
  const { connectionId } = await params;
  const quota = parseGeminiQuota(await request.json().catch(() => null));
  if (!quota) return Response.json({ error: "请输入有效的模型 ID 和非负整数额度。" }, { status: 400 });
  const saved = await setGeminiModelQuota(connectionId, quota.model, quota.limits, quota.partial);
  if (!saved) return Response.json({ error: "未找到该 Gemini 连接。" }, { status: 404 });
  return Response.json(quota);
}

export async function GET(request, { params }) {
  try {
    const { connectionId } = await params;
    const connection = await getProviderConnectionById(connectionId);
    if (!connection) return Response.json({ error: "Connection not found" }, { status: 404 });
    const force = new URL(request.url).searchParams.get("force") === "1";
    const usage = await loadConnectionUsage(connection, { force });
    void notifyAccountUsage(connection, usage).catch(() => console.warn("[Alerts] Unable to evaluate quota response"));
    return Response.json(usage);
  } catch (error) {
    return Response.json({ error: error.message }, { status: error.status === 401 ? 401 : 500 });
  }
}
