import { createHash } from "node:crypto";
import { getAdapter } from "./db/driver.js";
import { parseJson } from "./db/helpers/jsonCol.js";
import { getExclusiveApiKeyIds } from "@/shared/utils/accountApiKeyBindings.js";
import { getCodexTrialIdentity } from "@/shared/utils/codexTrialIdentity.js";

export const RECENT_ACCOUNT_USAGE_MS = 6 * 3600000;

export async function getRecentAccountApiKeyUsers(connections, now = Date.now()) {
  const result = new Map(connections.map(connection => [connection.id, []]));
  const ids = [...new Set(connections.filter(connection => !getExclusiveApiKeyIds(connection).length).map(connection => connection.id))];
  if (!ids.length) return result;
  await globalThis._requestErrorWrites?.pending;
  const db = await getAdapter();
  const keys = db.all("SELECT id, key, name, isActive FROM apiKeys");
  const byValue = new Map(keys.map(key => [key.key, key])), byId = new Map(keys.map(key => [key.id, key]));
  const placeholders = ids.map(() => "?").join(",");
  const start = now - RECENT_ACCOUNT_USAGE_MS;
  // Aggregate the time window before returning rows; never truncate recent callers by a log-row limit.
  const usage = db.all(`SELECT connectionId, apiKey, MAX(timestamp) AS lastUsedAt
    FROM usageHistory INDEXED BY idx_uh_ts WHERE timestamp >= ? AND timestamp < ? AND connectionId IN (${placeholders})
    GROUP BY connectionId, apiKey`, [new Date(start).toISOString(), new Date(now).toISOString(), ...ids]);
  const errors = db.all(`SELECT connectionId,
    CASE WHEN json_valid(data) THEN data -> '$.apiKeyId' END AS apiKeyId,
    CASE WHEN json_valid(data) THEN data -> '$.apiKeyName' END AS apiKeyName,
    MAX(timestamp) AS lastUsedAt
    FROM requestErrors INDEXED BY idx_re_ts WHERE timestamp >= ? AND timestamp < ? AND connectionId IN (${placeholders})
    GROUP BY connectionId, apiKeyId, apiKeyName`, [start, now, ...ids]);
  const users = new Map(ids.map(id => [id, new Map()]));
  function caller(key, deletedIdentity, historicalName) {
    if (key) return { id: key.id, name: (key.name || key.id) + (key.isActive ? "" : "（已停用）") };
    if (!deletedIdentity) return { id: "unattributed", name: "未记录 API Key" };
    const hash = createHash("sha256").update(deletedIdentity).digest("hex").slice(0, 16);
    const name = typeof historicalName === "string" && historicalName.trim() ? `${historicalName.trim()}（已删除）` : `已删除 Key（${hash.slice(0, 8)}）`;
    return { id: `deleted-${hash}`, name };
  }
  function remember(connectionId, user, timestamp) {
    const time = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
    if (!Number.isFinite(time)) return;
    const lastUsedAt = new Date(time).toISOString(), previous = users.get(connectionId).get(user.id);
    if (!previous || lastUsedAt > previous.lastUsedAt) users.get(connectionId).set(user.id, { ...user, lastUsedAt });
  }
  for (const row of usage) {
    if (getCodexTrialIdentity(row.apiKey)) continue;
    remember(row.connectionId, caller(byValue.get(row.apiKey), row.apiKey ? `key:${row.apiKey}` : null), row.lastUsedAt);
  }
  for (const row of errors) {
    const value = parseJson(row.apiKeyId), id = typeof value === "string" && value.trim() ? value : null;
    if (getCodexTrialIdentity(id, parseJson(row.apiKeyName))) continue;
    remember(row.connectionId, caller(byId.get(id), id ? `id:${id}` : null, parseJson(row.apiKeyName)), row.lastUsedAt);
  }
  for (const [id, callers] of users) result.set(id, [...callers.values()].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt) || a.id.localeCompare(b.id)));
  return result;
}
