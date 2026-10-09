import { getSettings, updateSettings } from "@/lib/localDb";
import { getProviderModels } from "open-sse/config/providerModels.js";
import { getCodexRoutingPolicy, normalizeCodexRouting } from "@/sse/local/routingPolicy.js";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
const fallbackModels = () => getProviderModels("cx")
  .filter(model => model.id.endsWith("-luna") && !model.kind && !model.quotaFamily)
  .map(model => ({ value: model.id, label: model.name || model.id }));

export async function GET() {
  return Response.json({ config: getCodexRoutingPolicy(await getSettings()), models: fallbackModels() }, { headers });
}

export async function PATCH(request) {
  try {
    const config = normalizeCodexRouting(await request.json(), getCodexRoutingPolicy(await getSettings()));
    if (!fallbackModels().some(model => model.value === config.quotaFallbackModel)) throw new Error("请选择可用的 Luna 模型");
    await updateSettings({ localCodexRouting: config });
    return Response.json({ config, models: fallbackModels() }, { headers });
  } catch (error) {
    return Response.json({ error: error.message || "保存账号路由配置失败" }, { status: 400, headers });
  }
}
