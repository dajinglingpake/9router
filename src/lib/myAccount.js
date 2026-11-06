import crypto from "node:crypto";
import { getApiKeyById, getApiKeyByValue } from "@/lib/db/repos/apiKeysRepo.js";
import { getProviderConnections } from "@/lib/db/repos/connectionsRepo.js";
import { isIpAllowed } from "@/lib/apiKeys/accessPolicy.js";
import { extractClientIp } from "@/sse/utils/clientIp.js";
import { getExclusiveApiKeyIds } from "@/shared/utils/accountApiKeyBindings.js";
import { createMyAccountToken, verifyMyAccountToken } from "@/lib/auth/dashboardSession.js";
import { loadConnectionUsage, supportsConnectionUsage } from "@/lib/providerUsage.js";
import { parseQuotaData, getRemainingPercentage } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import { AI_PROVIDERS } from "@/shared/constants/providers.js";

function bearer(request) {
  return request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1] || "";
}

function allowed(key, request) {
  return key?.isActive && isIpAllowed(key.allowedIps, extractClientIp(request));
}

export async function openMyAccountSession(request) {
  const key = await getApiKeyByValue(bearer(request));
  if (!allowed(key, request)) return null;
  return { token: await createMyAccountToken(key), expiresIn: 1800 };
}

export async function getMyAccountKey(request) {
  const claims = await verifyMyAccountToken(bearer(request));
  if (!claims?.sub) return null;
  const key = await getApiKeyById(claims.sub);
  if (!allowed(key, request)) return null;
  // Rotating or disabling the original key immediately revokes its view tokens.
  if (crypto.createHash("sha256").update(key.key).digest("hex") !== claims.keyDigest) return null;
  return key;
}

function quotaSummary(provider, usage) {
  // Explicit allow-list; never return provider responses, credentials or raw errors.
  return parseQuotaData(provider, usage).map(row => ({
    name: row.name,
    remainingPercentage: row.isCreditBalance || row.unlimited ? null : Math.min(100, Math.max(0, getRemainingPercentage(row))),
    resetAt: row.resetAt || null,
    unlimited: row.unlimited === true,
    balance: row.isCreditBalance ? Math.max(0, row.total - row.used) : null,
    balanceLabel: row.isCreditBalance ? row.balanceLabel || `${Math.max(0, row.total - row.used)} ${row.currency || row.unit || ""}`.trim() : null,
  }));
}

async function accountSummary(connection) {
  const account = {
    id: connection.id,
    name: connection.name || connection.displayName || connection.email || "未命名账号",
    provider: connection.provider,
    providerName: AI_PROVIDERS[connection.provider]?.name || connection.provider,
    active: connection.isActive !== false,
    quotas: [],
    message: null,
  };
  if (!supportsConnectionUsage(connection)) {
    return { ...account, message: "该渠道暂不提供额度查询。" };
  }
  try {
    const usage = await loadConnectionUsage(connection, { signal: AbortSignal.timeout(20000) });
    account.quotas = quotaSummary(connection.provider, usage);
    account.plan = typeof usage?.plan === "string" ? usage.plan : null;
    const codeUsed = usage?.usageBreakdown?.monthlyCodeUsedPercentage;
    if (connection.provider === "kimi" && Number.isFinite(codeUsed)) account.monthlyCodeUsedPercentage = codeUsed;
    if (!account.quotas.length) account.message = "暂时无法获取额度，请稍后刷新或联系管理员。";
  } catch {
    account.message = "额度查询失败，请稍后刷新或联系管理员。";
  }
  return account;
}

export async function loadMyAccount(key) {
  const connections = await getProviderConnections();
  const bound = connections.filter(c => getExclusiveApiKeyIds(c).includes(key.id));
  const accounts = await Promise.all(bound.map(accountSummary));
  // Bindings can change while upstream quota calls are in flight.
  const current = (await getProviderConnections()).filter(c => getExclusiveApiKeyIds(c).includes(key.id));
  const currentIds = new Set(current.map(c => c.id));
  return {
    name: key.name,
    binding: current.length ? "dedicated" : "shared",
    accounts: accounts.filter(account => currentIds.has(account.id)),
    checkedAt: new Date().toISOString(),
  };
}
