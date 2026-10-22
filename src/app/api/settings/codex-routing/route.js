import { getSettings, updateSettings, getProviderConnections } from "@/lib/localDb";
import { resolveCodexCatalog } from "@/lib/codexModels";
import { getCodexRoutingPolicy, normalizeCodexRouting } from "@/sse/local/routingPolicy.js";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
const fallbackModels = async () => {
  const connections = (await getProviderConnections({ provider: "codex", isActive: true }))
    .filter(connection => connection.provider === "codex" && connection.isActive !== false);
  const catalog = await resolveCodexCatalog(connections, { respectEnabledModels: true });
  return catalog.models.filter(model => model.id.endsWith("-luna"))
    .map(model => ({ value: model.id, label: model.name || model.id }));
};

export async function GET() {
  return Response.json({ config: getCodexRoutingPolicy(await getSettings()), models: await fallbackModels() }, { headers });
}

export async function PATCH(request) {
  try {
    const previous = getCodexRoutingPolicy(await getSettings());
    const config = normalizeCodexRouting(await request.json(), previous);
    const models = await fallbackModels();
    if (config.quotaFallbackModel !== previous.quotaFallbackModel && !models.some(model => model.value === config.quotaFallbackModel)) throw new Error("请选择可用的 Luna 模型");
    await updateSettings({ localCodexRouting: config });
    return Response.json({ config, models }, { headers });
  } catch (error) {
    return Response.json({ error: error.message || "保存账号路由配置失败" }, { status: 400, headers });
  }
}
