import { getApiKeyByValue } from "@/lib/db/repos/apiKeysRepo.js";
import { isIpAllowed } from "@/lib/apiKeys/accessPolicy.js";
import { extractClientApiKey } from "./keyAccess.js";
import { extractClientIp } from "../utils/clientIp.js";
import { getExclusiveApiKeyIds } from "@/shared/utils/accountApiKeyBindings.js";

const requestKeyIds = new WeakMap();

async function getRequestKeyId(request) {
  if (!request) return null;
  if (!requestKeyIds.has(request)) {
    requestKeyIds.set(request, (async () => {
      const key = extractClientApiKey(request);
      const record = key ? await getApiKeyByValue(key) : null;
      return record?.isActive && isIpAllowed(record.allowedIps, extractClientIp(request)) ? record.id : null;
    })());
  }
  return requestKeyIds.get(request);
}

export function filterAccountPoolByApiKey(connections, apiKeyId) {
  // Include disabled accounts when deciding whether this key has a private pool.
  // Disabling an account must never send its owner back into the shared pool.
  const dedicated = apiKeyId ? connections.find(c => getExclusiveApiKeyIds(c).includes(apiKeyId)) : null;
  return dedicated ? [dedicated] : connections.filter(c => !getExclusiveApiKeyIds(c).length);
}

export async function filterAccountPoolForRequest(connections, request) {
  if (!connections.some(c => getExclusiveApiKeyIds(c).length)) return connections;
  return filterAccountPoolByApiKey(connections, await getRequestKeyId(request));
}
