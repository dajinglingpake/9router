import { listTrials, startTrials, stopTrials } from "@/lib/codexTrials/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try { return Response.json(await listTrials(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return Response.json({ error: error.message }, { status: 500 }); }
}

export async function POST(request) {
  try {
    if (!request.headers.get("content-type")?.includes("application/json")) return Response.json({ error: "请求必须使用 JSON。" }, { status: 415 });
    const input = await request.json();
    if (input.action === "stop") return Response.json(stopTrials());
    return Response.json(await startTrials(input), { status: 202 });
  } catch (error) { return Response.json({ error: error.message }, { status: error.status || 400 }); }
}
