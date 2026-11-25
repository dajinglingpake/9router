import { getProviderConnections } from "@/lib/localDb";
import { resolveGeminiChatCatalog } from "@/lib/geminiModels";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const accounts = await getProviderConnections({ provider: "gemini", isActive: true });
  const params = new URL(request.url).searchParams;
  const catalog = await resolveGeminiChatCatalog(accounts, {
    forceRefresh: params.get("refresh") === "1", visibleOnly: params.get("visible") === "1", includePricing: true,
  });
  return Response.json(catalog, { headers: { "Cache-Control": "no-store" } });
}
