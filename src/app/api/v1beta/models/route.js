import { PROVIDER_MODELS } from "@/shared/constants/models";
import { getProviderConnections } from "@/lib/localDb";
import { resolveCodexCatalog } from "@/lib/codexModels";
import { resolveGeminiChatCatalog, withGeminiMediaModels } from "@/lib/geminiModels";
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

    function addModel({ name, displayName, description, methods = ["generateContent"], capabilities }) {
      if (seen.has(name)) return;
      seen.add(name);
      models.push({
        name,
        displayName,
        description,
        supportedGenerationMethods: methods,
        inputTokenLimit: capabilities?.contextWindow ?? 128000,
        outputTokenLimit: capabilities?.maxOutput ?? 8192,
      });
    }
    
    const connections = await getProviderConnections();
    const available = (await Promise.all(["codex", ...MODEL_TEST_PROVIDERS].map(provider =>
      filterAccountPoolForRequest(connections.filter(connection => connection.provider === provider), request)
    ))).flat().filter(connection => connection.isActive !== false);
    const preferences = await getProviderModelPreferences().catch(() => new Map());
    const [codex, gemini, disabled] = await Promise.all([
      resolveCodexCatalog(available.filter(connection => connection.provider === "codex"), { respectEnabledModels: true }),
      resolveGeminiChatCatalog(available, { freeOnly: preferences.get("gemini")?.freeOnly }),
      getDisabledModels(),
    ]);
    const catalog = { ...PROVIDER_MODELS, cx: codex.models,
      gemini: withGeminiMediaModels(gemini.models, gemini.freeOnly).filter(model => !disabled.gemini?.includes(model.id)),
    };
    delete catalog.codex;
    if (preferences.get("kilocode")?.freeOnly) {
      const kilo = await resolveKiloCatalog(available.filter(connection => connection.provider === "kilocode"), { respectEnabledModels: true });
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
          capabilities: provider === "gemini" ? model.capabilities : undefined,
        });

        if (provider === "gemini") {
          addModel({
            name: `models/${model.id}`,
            displayName: model.name || model.id,
            description: `Gemini model: ${model.name || model.id}`,
            methods: ["generateContent", "streamGenerateContent"],
            capabilities: model.capabilities,
          });
        }
      }
    }

    const ordered = await orderModelsByTestResult(models, available, preferences, model => {
      const id = model.name.slice("models/".length);
      return id.includes("/") ? id : `gemini/${id}`;
    }).catch(() => models);
    return Response.json({ models: ordered });
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json({ error: { message: error.message } }, { status: 500 });
  }
}
