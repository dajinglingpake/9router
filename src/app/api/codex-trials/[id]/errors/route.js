import { getTrialRecord } from "@/lib/codexTrials/store";
import { getRequestDiagnostics, parseDiagnosticsQuery } from "@/lib/requestDiagnostics";
import { CODEX_TRIAL_IDENTITY } from "@/shared/utils/codexTrialIdentity.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function GET(request, { params }) {
  let options;
  try {
    const { id } = await params;
    const record = getTrialRecord(id);
    if (!record) return Response.json({ error: "该账号尚无测试记录。" }, { status: 404, headers });
    const query = new URL(request.url).searchParams;
    // Derive the scope and clock from the saved run, never from the browser's local time.
    options = parseDiagnosticsQuery(new URLSearchParams({
      start: record.startedAt || record.queuedAt,
      end: new Date((record.finishedAt ? Date.parse(record.finishedAt) : Date.now()) + 1000).toISOString(),
      provider: record.provider || "codex", model: record.model, focusConnectionId: record.connectionId,
      apiKeyId: CODEX_TRIAL_IDENTITY.id,
      issue: query.get("issue") || "error", page: query.get("page") || "1",
    }));
  } catch (error) { return Response.json({ error: error.message }, { status: 400, headers }); }
  try { return Response.json(await getRequestDiagnostics({ ...options, detailsOnly: true }), { headers }); }
  catch (error) {
    console.error("[Codex trials] Unable to read request details:", error.message);
    return Response.json({ error: "读取本轮请求失败，请稍后重试。" }, { status: 500, headers });
  }
}
