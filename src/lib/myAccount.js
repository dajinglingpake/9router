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
import { getModelInfo, getComboModels } from "@/sse/services/model.js";
import { buildCodexQuotaSummary } from "@/lib/local/codexQuotaSummary.js";

// Shared quotas are available for the desktop launcher's two account pools.
const SHARED_PROVIDERS = new Set(["codex", "kimi"]);

async function sharedProvidersForKey(key) {
  if (!key.access?.restricted) return SHARED_PROVIDERS;
  const providers = new Set();
  const seen = new Set();
  async function visit(model) {
    if (typeof model !== "string" || seen.has(model)) return;
    seen.add(model);
    const members = await getComboModels(model, key.id);
    if (members) {
      for (const member of members) await visit(member);
    } else {
      const info = await getModelInfo(model, key.id);
      if (!info?.disabled && SHARED_PROVIDERS.has(info?.provider)) providers.add(info.provider);
    }
  }
  for (const model of key.access.allow || []) await visit(model);
  return providers;
}

function visibleAccounts(connections, key, sharedProviders) {
  const bound = connections.filter(c => getExclusiveApiKeyIds(c).includes(key.id));
  const boundProviders = new Set(bound.map(c => c.provider));
  const shared = connections.filter(c => sharedProviders.has(c.provider) && !boundProviders.has(c.provider)
    && c.isActive !== false && getExclusiveApiKeyIds(c).length === 0);
  return [...bound, ...shared];
}

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

async function accountSummary(connection, key, sharedIndex, snapshots) {
  const shared = !getExclusiveApiKeyIds(connection).includes(key.id);
  const providerName = AI_PROVIDERS[connection.provider]?.name || connection.provider;
  const account = {
    id: connection.id,
    name: shared ? `${providerName} 共享账号 ${sharedIndex}` : connection.name || connection.displayName || connection.email || "未命名账号",
    provider: connection.provider,
    providerName,
    shared,
    active: connection.isActive !== false,
    quotas: [],
    message: null,
  };
  if (!supportsConnectionUsage(connection)) {
    return { ...account, message: "该渠道暂不提供额度查询。" };
  }
  try {
    const usage = await loadConnectionUsage(connection, { signal: AbortSignal.timeout(20000) });
    if (shared && connection.provider === "codex") snapshots.set(connection.id, usage);
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
  const sharedProviders = await sharedProvidersForKey(key);
  const connections = await getProviderConnections();
  const visible = visibleAccounts(connections, key, sharedProviders);
  const counts = {};
  const snapshots = new Map();
  const accounts = await Promise.all(visible.map(c => {
    const index = counts[c.provider] = (counts[c.provider] || 0) + 1;
    return accountSummary(c, key, index, snapshots);
  }));
  // Bindings can change while upstream quota calls are in flight.
  const current = visibleAccounts(await getProviderConnections(), key, sharedProviders);
  const currentIds = new Set(current.map(c => c.id));
  const filtered = accounts.filter(account => currentIds.has(account.id)
    && account.shared === !getExclusiveApiKeyIds(current.find(c => c.id === account.id)).includes(key.id));
  // Aggregate only still-visible shared accounts, using the quota tracker's calculation.
  const sharedCodexIds = new Set(filtered.filter(a => a.shared && a.provider === "codex").map(a => a.id));
  const result = filtered.filter(a => !sharedCodexIds.has(a.id));
  if (sharedCodexIds.size) {
    const summary = buildCodexQuotaSummary(visible.filter(c => sharedCodexIds.has(c.id)), snapshots);
    result.unshift({
      id: "codex-shared", name: "Codex 共享总额度", provider: "codex", providerName: "Codex",
      shared: true, active: true, quotas: [], codexSummary: summary,
      message: summary.accountCount ? null : "该渠道暂不提供额度查询。",
    });
  }
  return {
    name: key.name,
    binding: filtered.some(a => !a.shared) ? "dedicated" : "shared",
    accounts: result,
    checkedAt: new Date().toISOString(),
  };
}
