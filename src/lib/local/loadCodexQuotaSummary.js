import { getProviderConnections } from "../db/repos/connectionsRepo.js";
import { getCodexQuotaUsageRows } from "../db/repos/usageRepo.js";
import { loadCodexQuotaSnapshot } from "../../sse/local/quotaRouting.js";
import { buildCodexQuotaSummary, normalizeCodexPlan } from "./codexQuotaSummary.js";
import { CODEX_ESTIMATE_LOOKBACK_MS, estimateCodexQuota } from "./codexQuotaEstimate.js";
import { getExclusiveApiKeyNames } from "../accountApiKeyBindings.js";

export async function loadCodexQuotaSummary({ force = false, includeEstimates = false } = {}) {
  const connections = (await getProviderConnections({ provider: "codex", isActive: true }))
    .filter(connection => connection.authType === "oauth");
  const snapshots = new Map(await Promise.all(connections.map(async connection => [
    connection.id, await loadCodexQuotaSnapshot(connection, { force }),
  ])));
  const names = await getExclusiveApiKeyNames(connections);
  const now = Date.now();
  let estimates = null;
  if (includeEstimates) {
    const plans = new Map(connections.map(({ id }) => [id, normalizeCodexPlan(snapshots.get(id)?.plan)]));
    const rows = await getCodexQuotaUsageRows([...plans.keys()], now - CODEX_ESTIMATE_LOOKBACK_MS);
    estimates = estimateCodexQuota(rows, plans);
  }
  return buildCodexQuotaSummary(connections.map(connection => ({
    ...connection, exclusiveApiKeyNames: names.get(connection.id),
  })), snapshots, now, estimates);
}
