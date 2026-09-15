import { getProviderConnectionById } from "@/lib/localDb";
import { loadConnectionUsage } from "@/lib/providerUsage";
import { notifyAccountUsage } from "@/lib/alerts/monitor";

export { refreshAndUpdateCredentials } from "@/lib/providerUsage";

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
