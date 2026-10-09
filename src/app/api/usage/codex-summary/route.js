import { loadCodexQuotaSummary } from "@/lib/local/loadCodexQuotaSummary.js";
import { notifyCodexQuotaSummary } from "@/lib/alerts/codexQuota.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const force = new URL(request.url).searchParams.get("force") === "1";
    const summary = await loadCodexQuotaSummary({ force });
    void notifyCodexQuotaSummary(summary).catch(() => console.warn("[Alerts] Unable to evaluate total quota"));
    return Response.json(summary, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "读取 Codex 总额度失败，请重试" }, { status: 500 });
  }
}
