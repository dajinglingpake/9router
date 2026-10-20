import { getCustomModels, getProviderNodes } from "@/lib/localDb";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { CODEX_TRIAL_MODEL } from "@/shared/utils/codexTrial";

const textModel = model => (model.kind || model.type || "llm") === "llm"
  && model.quotaFamily !== "review" && !model.id.endsWith("-review") && !model.id.endsWith("[1m]");

// Use the local model catalog: polling test results must never probe upstream accounts.
export async function getTrialProviders(connections) {
  const [nodes, customModels] = await Promise.all([getProviderNodes(), getCustomModels()]);
  return [...new Set(connections.map(connection => connection.provider))].flatMap(id => {
    const node = nodes.find(item => item.id === id);
    const definition = AI_PROVIDERS[id];
    if (node ? !["openai-compatible", "anthropic-compatible"].includes(node.type)
      : !definition || !(definition.serviceKinds || ["llm"]).includes("llm")) return [];
    const aliases = new Set([id, definition?.alias, node?.prefix].filter(Boolean));
    const entries = [...getModelsByProviderId(id), ...customModels.filter(model => aliases.has(model.providerAlias))];
    const models = [...new Map(entries.filter(textModel).map(model => [model.id, {
      id: model.id, name: model.name || model.id, efforts: getThinkingLevels(id, model.id) || [],
    }])).values()];
    return [{
      id, name: node?.name || definition?.name || id, models,
      defaultModel: models.find(model => model.id === CODEX_TRIAL_MODEL)?.id || models[0]?.id || "",
      allowCustomModel: !!node || !!definition?.passthroughModels || !models.length,
    }];
  });
}
