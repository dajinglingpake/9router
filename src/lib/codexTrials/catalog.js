import { getCustomModels, getProviderNodes } from "@/lib/localDb";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { CODEX_TRIAL_MODEL } from "@/shared/utils/codexTrial";
import { resolveCodebuddyModels } from "@/lib/codebuddyModels";
import { resolveCodexCatalog } from "@/lib/codexModels";

const textModel = model => (model.kind || model.type || "llm") === "llm"
  && model.quotaFamily !== "review" && !model.id.endsWith("-review") && !model.id.endsWith("[1m]");

// Discovery is opt-in: polling test results must never probe upstream accounts.
export async function getTrialProviders(connections, { discoverModels = false } = {}) {
  const [nodes, customModels] = await Promise.all([getProviderNodes(), getCustomModels()]);
  const codex = await resolveCodexCatalog(connections, { forceRefresh: discoverModels, cachedOnly: !discoverModels });
  const liveModels = discoverModels
    ? (await Promise.all(connections.filter(connection => connection.provider === "codebuddy-cn")
      .map(connection => resolveCodebuddyModels(connection)))).flatMap(result => result.models)
    : [];
  return [...new Set(connections.map(connection => connection.provider))].flatMap(id => {
    const node = nodes.find(item => item.id === id);
    const definition = AI_PROVIDERS[id];
    if (node ? !["openai-compatible", "anthropic-compatible"].includes(node.type)
      : !definition || !(definition.serviceKinds || ["llm"]).includes("llm")) return [];
    const aliases = new Set([id, definition?.alias, node?.prefix].filter(Boolean));
    const catalog = id === "codex" ? codex.models : id === "codebuddy-cn" && liveModels.length ? liveModels : getModelsByProviderId(id);
    const entries = [...catalog, ...(id === "codex" ? [] : customModels.filter(model => aliases.has(model.providerAlias)))];
    const models = [...new Map(entries.filter(textModel).map(model => [model.id, {
      id: model.id, name: model.name || model.id,
      efforts: model.supportedEffortLevels?.length ? model.supportedEffortLevels : getThinkingLevels(id, model.id) || [],
      ...(id === "codex" ? { connectionIds: model.connectionIds } : {}),
    }])).values()];
    return [{
      id, name: node?.name || definition?.name || id, models,
      defaultModel: models.find(model => model.id === CODEX_TRIAL_MODEL)?.id || models[0]?.id || "",
      allowCustomModel: id !== "codex" && (!!node || !!definition?.passthroughModels || !models.length),
      ...(id === "codex" ? { warning: codex.accounts.filter(account => account.warning).map(account => account.warning).join("；") } : {}),
    }];
  });
}
