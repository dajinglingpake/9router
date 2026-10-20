import { deleteTrialRecord, getTrialRecord } from "@/lib/codexTrials/store";
import { CODEX_TRIAL_CSP, trialPreviewDocument } from "@/shared/utils/codexTrial";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    return Response.json(deleteTrialRecord(id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return Response.json({ error: error.message }, { status: error.status || 500 }); }
}

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const record = getTrialRecord(id);
    if (!record) return Response.json({ error: "该账号尚无测试记录。" }, { status: 404 });
    const format = new URL(request.url).searchParams.get("format");
    if (format === "html" || format === "download") {
      if (!record.html) return Response.json({ error: "本次测试没有生成作品。" }, { status: 404 });
      return new Response(format === "html" ? trialPreviewDocument(record.html) : record.html, { headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": CODEX_TRIAL_CSP,
        "X-Content-Type-Options": "nosniff",
        ...(format === "download" ? { "Content-Disposition": `attachment; filename="codex-trial-${id}.html"` } : {}),
      } });
    }
    const { html, ...detail } = record;
    return Response.json({ ...detail, hasHtml: !!html }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return Response.json({ error: error.message }, { status: error.status || 500 }); }
}
