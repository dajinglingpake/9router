import { PROVIDER_MODELS } from "@/shared/constants/models";
import { getProviderConnections } from "@/lib/localDb";
import { resolveCodexCatalog } from "@/lib/codexModels";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { resolveKiloCatalog } from "@/lib/kiloModels";
import { getProviderModelPreferences, orderModelsByTestResult } from "@/lib/modelTests";
import { MODEL_TEST_PROVIDERS } from "@/shared/utils/modelTests";
import { filterAccountPoolForRequest } from "@/sse/services/accountApiKeyAccess.js";

export const dynamic = "force-dynamic";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * GET /v1beta/models - Gemini compatible models list
 * Returns models in Gemini API format
 */
export async function GET(request) {
  try {
    const models = [];
    const seen = new Set();

    function addModel({ name, displayName, description, methods = ["generateContent"] }) {
      if (seen.has(name)) return;
      seen.add(name);
      models.push({
        name,
        displayName,
        description,
        supportedGenerationMethods: methods,
        inputTokenLimit: 128000,
        outputTokenLimit: 8192,
      });
    }
    
    const connections = await getProviderConnections();
    const available = (await Promise.all(["codex", ...MODEL_TEST_PROVIDERS].map(provider =>
      filterAccountPoolForRequest(connections.filter(connection => connection.provider === provider), request)
    ))).flat().filter(connection => connection.isActive !== false);
    const codex = await resolveCodexCatalog(available.filter(connection => connection.provider === "codex"), { respectEnabledModels: true });
    const catalog = { ...PROVIDER_MODELS, cx: codex.models };
    delete catalog.codex;
    const preferences = await getProviderModelPreferences().catch(() => new Map());
    if (preferences.get("kilocode")?.freeOnly) {
      const [kilo, disabled] = await Promise.all([
        resolveKiloCatalog(available.filter(connection => connection.provider === "kilocode"), { respectEnabledModels: true }),
        getDisabledModels(),
      ]);
      const disabledIds = new Set([...(disabled.kc || []), ...(disabled.kilocode || [])]);
      catalog.kc = kilo.models.filter(model => model.isFree === true && !disabledIds.has(model.id));
      delete catalog.kilocode;
    }
    for (const [provider, providerModels] of Object.entries(catalog)) {
      for (const model of providerModels) {
        addModel({
          name: `models/${provider}/${model.id}`,
          displayName: model.name || model.id,
          description: `${provider} model: ${model.name || model.id}`,
        });

        if (provider === "gemini") {
          addModel({
            name: `models/${model.id}`,
            displayName: model.name || model.id,
            description: `Gemini model: ${model.name || model.id}`,
            methods: ["generateContent", "streamGenerateContent"],
          });
        }
      }
    }

    const ordered = await orderModelsByTestResult(models, available, preferences, model => model.name.slice("models/".length)).catch(() => models);
    return Response.json({ models: ordered });
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json({ error: { message: error.message } }, { status: 500 });
  }
}
