import { getApiKeys } from "./db/repos/apiKeysRepo.js";
import { parseJson } from "./db/helpers/jsonCol.js";
import { getExclusiveApiKeyIds } from "@/shared/utils/accountApiKeyBindings.js";

export async function getExclusiveApiKeyNames(connections) {
  const keys = connections.some(c => getExclusiveApiKeyIds(c).length) ? await getApiKeys() : [];
  const names = new Map(keys.map(key => [key.id, (key.name || key.id) + (key.isActive ? "" : "（已停用）")]));
  return new Map(connections.map(c => [c.id, getExclusiveApiKeyIds(c).map(id =>
    names.get(id) || "已删除 Key（" + id.slice(0, 8) + "）"
  )]));
}

export function assertExclusiveApiKeyBindings(db, connection) {
  const ids = new Set(getExclusiveApiKeyIds(connection));
  if (!ids.size) return;
  const others = db.all("SELECT name, data FROM providerConnections WHERE provider = ? AND id != ?", [connection.provider, connection.id]);
  const conflict = others.find(row => getExclusiveApiKeyIds(parseJson(row.data, {})).some(id => ids.has(id)));
  if (conflict) {
    const error = new Error("API Key 已绑定到此提供商的账号「" + (conflict.name || "未命名账号") + "」，请先解除原绑定。");
    error.code = "EXCLUSIVE_API_KEY_CONFLICT";
    throw error;
  }
}
