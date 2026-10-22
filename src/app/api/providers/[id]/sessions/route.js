import { getCodexSessions } from "@/lib/codexSessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function GET(_request, { params }) {
  try {
    const { id } = await params;
    return Response.json(await getCodexSessions(id), { headers });
  } catch (error) {
    return Response.json({ error: error.status ? error.message : "设备列表读取失败，请稍后重试。" }, { status: error.status || 500, headers });
  }
}
