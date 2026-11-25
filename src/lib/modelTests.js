import { getApiKeys, getProviderConnections, getSettings } from "@/lib/localDb";
import { getModelTests, getModelTestPreferences } from "@/lib/db/repos/modelTestsRepo.js";
import { isIpAllowed } from "@/lib/apiKeys/accessPolicy";
import { FREE_PROVIDERS, resolveProviderId } from "@/shared/constants/providers";
import { FREE_MODEL_FILTER_PROVIDERS, MODEL_TEST_PROVIDERS, modelTestRank } from "@/shared/utils/modelTests";
import { filterAccountPoolByApiKey } from "@/sse/services/accountApiKeyAccess.js";

function testScope(provider, connections) {
  if (FREE_PROVIDERS[provider]?.noAuth) return `modelTests:${provider}:public`;
  const ids = connections.filter(connection => connection.provider === provider && connection.isActive !== false)
    .map(connection => connection.id).sort();
  return ids.length ? `modelTests:${provider}:${ids.join(",")}` : null;
}

export function getTestedModelTarget(id) {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return null;
  const provider = resolveProviderId(id.slice(0, slash));
  return MODEL_TEST_PROVIDERS.includes(provider) ? { provider, model: id.slice(slash + 1) } : null;
}

// Run the dashboard test through the same account pool that a loopback key can
// actually access. Prefer a shared pool, then a dedicated account if necessary.
export async function getModelTestContext(provider) {
  const [connections, keys, settings] = await Promise.all([
    getProviderConnections({ provider }), getApiKeys(), getSettings(),
  ]);
  const shared = testScope(provider, filterAccountPoolByApiKey(connections, null));
  const candidates = keys.filter(key => key.isActive !== false && !key.access?.restricted && isIpAllowed(key.allowedIps, "127.0.0.1"))
    .map(key => ({ apiKey: key.key, scope: testScope(provider, filterAccountPoolByApiKey(connections, key.id)) }))
    .filter(candidate => candidate.scope);
  return candidates.find(candidate => candidate.scope === shared)
    || (shared && !settings.requireApiKey ? { apiKey: null, scope: shared } : null)
    || candidates[0] || null;
}

export async function getProviderModelPreferences() {
  const [overrides, settings] = await Promise.all([getModelTestPreferences(), getSettings()]);
  // Preserve the previous release's choice until an individual switch is saved.
  return new Map(MODEL_TEST_PROVIDERS.map(provider => {
    const saved = overrides.get(provider);
    return [provider, {
      hideFailedModels: saved?.hideFailedModels ?? (settings.hideFailedModels === true),
      ...(FREE_MODEL_FILTER_PROVIDERS.includes(provider) ? { freeOnly: saved?.freeOnly === true } : {}),
    }];
  }));
}

export async function orderModelsByTestResult(models, connections, preferences, getId = model => model.id) {
  const scopes = new Map(MODEL_TEST_PROVIDERS.map(provider => [provider, testScope(provider, connections)]));
  const results = await getModelTests([...scopes.values()].filter(Boolean));
  if (!results.size) return models;

  return models.map(item => {
    const target = getTestedModelTarget(getId(item));
    const result = target && results.get(scopes.get(target.provider))?.get(target.model);
    const hidden = result?.status === "error" && preferences.get(target.provider)?.hideFailedModels;
    return { item, rank: modelTestRank(result?.status), hidden };
  }).filter(entry => !entry.hidden)
    .sort((a, b) => a.rank - b.rank)
    .map(({ item }) => item);
}
