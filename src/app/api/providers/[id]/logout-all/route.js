import { logoutCodexConnection } from "@/lib/codexSessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function POST(request, { params }) {
  let origin;
  try { origin = new URL(request.headers.get("origin")); } catch { /* reject missing or invalid origins */ }
  if (!origin || !["http:", "https:"].includes(origin.protocol) || origin.host !== (request.headers.get("host") || new URL(request.url).host)) {
    return Response.json({ error: "请求来源无效。" }, { status: 403, headers });
  }
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return Response.json({ error: "请求必须使用 JSON。" }, { status: 415, headers });
  }
  let body;
  try { body = await request.json(); } catch {
    return Response.json({ error: "请求内容无效。" }, { status: 400, headers });
  }
  if (body?.confirm !== true) return Response.json({ error: "请确认退出所有设备。" }, { status: 400, headers });
  try {
    const { id } = await params;
    return Response.json(await logoutCodexConnection(id), { headers });
  } catch (error) {
    return Response.json({ error: error.status ? error.message : "退出操作失败，请稍后重试。" }, { status: error.status || 500, headers });
  }
}
