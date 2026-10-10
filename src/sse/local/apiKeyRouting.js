import { createHash } from "node:crypto";
import { getMeta, setMeta } from "@/lib/db/helpers/metaStore.js";
import { getAdapter } from "@/lib/db/driver.js";

export function getApiKeyRoutingKey(provider, recordId, apiKey) {
  if (!recordId && !apiKey) return null;
  // Provider-scoped identity; never persist the client's raw key.
  return createHash("sha256").update(JSON.stringify([provider, recordId ? ["id", recordId] : ["key", apiKey]])).digest("hex");
}

export async function getApiKeyBinding(key) {
  if (!key) return null;
  const value = await getMeta(`chat-api-key:${key}`);
  return value ? JSON.parse(value) : null;
}

export async function bindApiKey(key, provider, connectionId, apiKeyRecordId = null) {
  // Serialized by the existing account-selection mutex, persisted across restarts.
  await setMeta(`chat-api-key:${key}`, JSON.stringify({ provider, connectionId, apiKeyRecordId }));
}

export async function getApiKeyBindingCounts(provider) {
  const db = await getAdapter();
  const activeKeys = new Set(db.all("SELECT id FROM apiKeys WHERE isActive = 1").map(key => key.id));
  const counts = new Map();
  for (const { value } of db.all("SELECT value FROM _meta WHERE key LIKE ?", ["chat-api-key:%"])) {
    const binding = JSON.parse(value);
    // Deleted or disabled caller keys no longer reserve an account.
    if (binding.provider !== provider || (binding.apiKeyRecordId && !activeKeys.has(binding.apiKeyRecordId))) continue;
    counts.set(binding.connectionId, (counts.get(binding.connectionId) || 0) + 1);
  }
  return counts;
}
