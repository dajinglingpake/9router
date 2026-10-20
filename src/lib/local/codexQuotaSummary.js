import { CODEX_QUOTA_WINDOW_SECONDS } from "open-sse/config/local/codexQuotaWindows.js";
import { getExclusiveApiKeyIds } from "@/shared/utils/accountApiKeyBindings.js";

function remainingFraction(quota, now) {
  if (!quota || quota.unlimited || !Number.isFinite(quota.used) || quota.used < 0 || !Number.isFinite(quota.total) || quota.total <= 0) return null;
  if (quota.resetAt && new Date(quota.resetAt).getTime() <= now) return null;
  return Math.max(0, Math.min(1, (quota.total - quota.used) / quota.total));
}

function metric(values) {
  const known = values.map(value => value.remaining).filter(Number.isFinite);
  const resets = values.map(value => value.resetAt).filter(Boolean).sort();
  const equivalentAccounts = known.reduce((sum, value) => sum + value, 0);
  return {
    accountCount: values.length,
    knownAccounts: known.length,
    remainingPercent: known.length ? Number((equivalentAccounts / known.length * 100).toFixed(8)) : null,
    equivalentAccounts,
    knownResetAccounts: resets.length,
    earliestResetAt: resets[0] || null,
    latestResetAt: resets.at(-1) || null,
  };
}

// Percent quotas are comparable within a plan, not absolute token/request balances.
// Count only applicable windows: some accounts have one weekly limit and no 5h limit.
export function buildCodexQuotaSummary(connections, snapshots, now = Date.now()) {
  const accounts = connections.filter(connection => connection.provider === "codex" && connection.isActive !== false && connection.authType === "oauth");
  const groups = new Map();
  let unknownAccounts = 0;
  for (const connection of accounts) {
    const usage = snapshots.get(connection.id);
    const quotas = usage?.quotas || {};
    const periods = Object.keys(CODEX_QUOTA_WINDOW_SECONDS);
    const hasDurations = periods.some(name => Object.values(CODEX_QUOTA_WINDOW_SECONDS).includes(quotas[name]?.windowSeconds));
    const row = {};
    row.sharedWeekly = quotas.session?.sharedWith === "weekly";
    for (const name of periods) {
      const applicable = !!quotas[name] || !hasDurations;
      const remaining = applicable ? remainingFraction(quotas[name], now) : null;
      const resetMs = new Date(quotas[name]?.resetAt).getTime();
      row[name] = {
        applicable, remaining,
        resetAt: remaining !== null && Number.isFinite(resetMs) && resetMs > now ? new Date(resetMs).toISOString() : null,
      };
    }
    if (periods.some(name => row[name].applicable && row[name].remaining === null)) unknownAccounts++;
    const plan = typeof usage?.plan === "string" ? usage.plan.trim().toLowerCase() || "unknown" : "unknown";
    const ids = getExclusiveApiKeyIds(connection);
    const scope = ids.length ? "dedicated" : "shared";
    const key = scope === "dedicated" ? `dedicated:${connection.id}` : `shared:${plan}`;
    if (!groups.has(key)) groups.set(key, {
      key, scope, plan, rows: [],
      ...(ids.length ? {
        connectionId: connection.id,
        name: connection.name || connection.email || connection.id,
        exclusiveApiKeyIds: ids,
        exclusiveApiKeyNames: connection.exclusiveApiKeyNames || [],
      } : {}),
    });
    groups.get(key).rows.push(row);
  }
  return {
    accountCount: accounts.length,
    sharedAccountCount: accounts.filter(connection => !getExclusiveApiKeyIds(connection).length).length,
    dedicatedAccountCount: accounts.filter(connection => getExclusiveApiKeyIds(connection).length).length,
    unknownAccounts,
    generatedAt: new Date(now).toISOString(),
    groups: [...groups.values()].map(({ rows, ...group }) => ({
      ...group,
      accountCount: rows.length,
      depletedAccounts: rows.filter(row => row.session.remaining === 0 || row.weekly.remaining === 0).length,
      sharedWeeklyAccounts: rows.filter(row => row.sharedWeekly).length,
      session: metric(rows.filter(row => row.session.applicable).map(row => row.session)),
      weekly: metric(rows.filter(row => row.weekly.applicable).map(row => row.weekly)),
    })).sort((a, b) => b.scope.localeCompare(a.scope) || a.plan.localeCompare(b.plan) || a.key.localeCompare(b.key)),
  };
}
