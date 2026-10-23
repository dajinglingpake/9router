import { getApiKeys } from "./db/repos/apiKeysRepo.js";

export function canUseCombo(combo, apiKeyId = null) {
  return combo.isActive !== false || !!(apiKeyId && Array.isArray(combo.allowedApiKeyIds)
    && combo.allowedApiKeyIds.includes(apiKeyId));
}

export async function validateComboApiKeyIds(value) {
  if (!Array.isArray(value) || value.some(id => typeof id !== "string" || !id.trim())) {
    return "API Key 白名单必须为 Key ID 数组。";
  }
  const ids = new Set((await getApiKeys()).map(key => key.id));
  if (value.some(id => !ids.has(id))) return "白名单中的 API Key 已不存在，请刷新后重试。";
  return null;
}
