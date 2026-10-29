import { getApiKeyByValue } from "@/lib/db/repos/apiKeysRepo.js";
import { getProviderConnections } from "@/lib/db/repos/connectionsRepo.js";
import { isIpAllowed } from "@/lib/apiKeys/accessPolicy.js";
import { extractClientApiKey } from "./keyAccess.js";
import { extractClientIp } from "../utils/clientIp.js";
import { getExclusiveApiKeyIds } from "@/shared/utils/accountApiKeyBindings.js";

const requestKeyIds = new WeakMap();
const requestBoundProviders = new WeakMap();

export async function getRequestKeyId(request) {
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

export async function getRequestBoundProviders(request) {
  if (!request) return null;
  if (!requestBoundProviders.has(request)) {
    requestBoundProviders.set(request, (async () => {
      const keyId = await getRequestKeyId(request);
      if (!keyId) return null;
      // Disabled dedicated accounts still reserve their provider. A failed
      // private route must not fall through to another provider's shared pool.
      const connections = await getProviderConnections();
      const providers = new Set(connections
        .filter(c => getExclusiveApiKeyIds(c).includes(keyId)).map(c => c.provider));
      return providers.size ? providers : null;
    })());
  }
  return requestBoundProviders.get(request);
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
