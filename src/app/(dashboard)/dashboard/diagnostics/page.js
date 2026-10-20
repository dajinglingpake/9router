import DiagnosticsDashboard from "./DiagnosticsDashboard";
import CodexTrialsPanel from "./CodexTrialsPanel";
import Link from "next/link";

export default async function DiagnosticsPage({ searchParams }) {
  const params = await searchParams;
  const initialFocus = params?.focusApiKeyId ? { dimension: "byApiKey", id: params.focusApiKeyId }
    : params?.focusConnectionId ? { dimension: "byAccount", id: params.focusConnectionId } : null;
  const trials = params?.tab === "trials" || params?.tab === "pelicans";
  return <div className="flex flex-col gap-6">
    <nav aria-label="请求诊断视图" className="flex gap-1 self-start rounded-xl border border-border bg-surface p-1 text-sm">
      <Link href="/dashboard/diagnostics" aria-current={!trials ? "page" : undefined} className={`rounded-lg px-4 py-2 ${!trials ? "bg-primary/10 font-medium text-primary" : "text-text-muted hover:bg-surface-2"}`}>请求分析</Link>
      <Link href="/dashboard/diagnostics?tab=trials" aria-current={trials ? "page" : undefined} className={`rounded-lg px-4 py-2 ${trials ? "bg-primary/10 font-medium text-primary" : "text-text-muted hover:bg-surface-2"}`}>账号测试</Link>
    </nav>
    {trials ? <CodexTrialsPanel /> : <DiagnosticsDashboard initialFocus={initialFocus} initialModel={typeof params?.model === "string" ? params.model : "all"}
    initialAccountLabel={typeof params?.accountLabel === "string" ? params.accountLabel : "all"}
    initialAccountColor={typeof params?.accountColor === "string" ? params.accountColor : "all"} />}
  </div>;
}
