import { getProviderConnections } from "@/models";
import { resolveKiloCatalog, resolveKiloModels } from "@/lib/kiloModels";

export async function GET(request) {
  const forceRefresh = new URL(request.url).searchParams.get("refresh") === "1";
  const connections = await getProviderConnections({ provider: "kilocode", isActive: true });
  const catalog = connections.length
    ? await resolveKiloCatalog(connections, { forceRefresh })
    : await resolveKiloModels(null, { forceRefresh });
  return Response.json(catalog, { status: catalog.error ? 502 : 200, headers: { "Cache-Control": "no-store" } });
}
