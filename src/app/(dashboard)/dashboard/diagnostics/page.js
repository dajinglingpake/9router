import DiagnosticsDashboard from "./DiagnosticsDashboard";

export default async function DiagnosticsPage({ searchParams }) {
  const params = await searchParams;
  const initialFocus = params?.focusApiKeyId ? { dimension: "byApiKey", id: params.focusApiKeyId }
    : params?.focusConnectionId ? { dimension: "byAccount", id: params.focusConnectionId } : null;
  return <DiagnosticsDashboard initialFocus={initialFocus} initialModel={typeof params?.model === "string" ? params.model : "all"} />;
}
