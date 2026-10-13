import { NextResponse } from "next/server";
import { getRequestDiagnostics, parseDiagnosticsQuery } from "@/lib/requestDiagnostics.js";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function GET(request) {
  let options;
  try { options = parseDiagnosticsQuery(new URL(request.url).searchParams); }
  catch (error) { return NextResponse.json({ error: error.message }, { status: 400, headers }); }
  try { return NextResponse.json(await getRequestDiagnostics(options), { headers }); }
  catch (error) {
    console.error("[Diagnostics] Unable to read request summary:", error.message);
    return NextResponse.json({ error: "读取请求诊断失败，请稍后重试。" }, { status: 500, headers });
  }
}
