import { getProviderConnections } from "../db/repos/connectionsRepo.js";
import { loadCodexQuotaSnapshot } from "../../sse/local/quotaRouting.js";
import { buildCodexQuotaSummary } from "./codexQuotaSummary.js";
import { getExclusiveApiKeyNames } from "../accountApiKeyBindings.js";

export async function loadCodexQuotaSummary({ force = false } = {}) {
  const connections = (await getProviderConnections({ provider: "codex", isActive: true }))
    .filter(connection => connection.authType === "oauth");
  const snapshots = new Map(await Promise.all(connections.map(async connection => [
    connection.id, await loadCodexQuotaSnapshot(connection, { force }),
  ])));
  const names = await getExclusiveApiKeyNames(connections);
  return buildCodexQuotaSummary(connections.map(connection => ({
    ...connection, exclusiveApiKeyNames: names.get(connection.id),
  })), snapshots);
}
