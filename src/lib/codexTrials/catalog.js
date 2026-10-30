import { getCustomModels, getProviderNodes } from "@/lib/localDb";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { CODEX_TRIAL_MODEL } from "@/shared/utils/codexTrial";
import { resolveCodebuddyModels } from "@/lib/codebuddyModels";
import { resolveKimiModels } from "@/lib/kimiModels";
import { resolveOpenAIModels } from "@/lib/openaiModels";
import { resolveCodexCatalog } from "@/lib/codexModels";

const textModel = model => (model.kind || model.type || "llm") === "llm"
  && model.quotaFamily !== "review" && !model.id.endsWith("-review") && !model.id.endsWith("[1m]");

const liveResolvers = { "codebuddy-cn": resolveCodebuddyModels, kimi: resolveKimiModels, openai: resolveOpenAIModels };

// Discovery is opt-in: polling test results must never probe upstream accounts.
export async function getTrialProviders(connections, { discoverModels = false, forceRefresh = false } = {}) {
  const [nodes, customModels] = await Promise.all([getProviderNodes(), getCustomModels()]);
  const codex = await resolveCodexCatalog(connections, { forceRefresh, cachedOnly: !discoverModels });
  const liveCatalogs = discoverModels
    ? await Promise.all(connections.filter(connection => liveResolvers[connection.provider])
      .map(async connection => ({ provider: connection.provider, ...await liveResolvers[connection.provider](connection) })))
    : [];
  return [...new Set(connections.map(connection => connection.provider))].flatMap(id => {
    const node = nodes.find(item => item.id === id);
    const definition = AI_PROVIDERS[id];
    if (node ? !["openai-compatible", "anthropic-compatible"].includes(node.type)
      : !definition || !(definition.serviceKinds || ["llm"]).includes("llm")) return [];
    const aliases = new Set([id, definition?.alias, node?.prefix].filter(Boolean));
    const live = liveCatalogs.filter(result => result.provider === id);
    const liveModels = live.flatMap(result => result.models);
    const catalog = id === "codex" ? codex.models : liveModels.length ? liveModels : getModelsByProviderId(id);
    const entries = [...catalog, ...(id === "codex" ? [] : customModels.filter(model => aliases.has(model.providerAlias)))];
    const models = [...new Map(entries.filter(textModel).map(model => [model.id, {
      id: model.id, name: model.name || model.id,
      efforts: id === "kimi" && Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels
        : model.supportedEffortLevels?.length ? model.supportedEffortLevels : getThinkingLevels(id, model.id) || [],
      ...(id === "codex" ? { connectionIds: model.connectionIds } : {}),
    }])).values()];
    const accountWarnings = id === "codex" ? codex.accounts.filter(account => account.warning).map(account => {
      const connection = connections.find(connection => connection.id === account.connectionId);
      return { connectionId: account.connectionId, warning: account.warning,
        name: connection?.displayName || connection?.name || connection?.email || account.connectionId };
    }) : [];
    return [{
      id, name: node?.name || definition?.name || id, models,
      defaultModel: models.find(model => model.id === CODEX_TRIAL_MODEL)?.id || models[0]?.id || "",
      allowCustomModel: id !== "codex" && (!!node || !!definition?.passthroughModels || !models.length),
      ...(id === "codex" ? { accountWarnings, warning: accountWarnings.map(account => `${account.name}：${account.warning}`).join("；") } : {}),
      ...(live.some(result => result.warning) ? { warning: [...new Set(live.map(result => result.warning).filter(Boolean))].join("；") } : {}),
    }];
  });
}
