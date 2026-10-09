import { CODEX_QUOTA_WINDOW_SECONDS } from "open-sse/config/local/codexQuotaWindows.js";

function remainingFraction(quota, now) {
  if (!quota || quota.unlimited || !Number.isFinite(quota.used) || quota.used < 0 || !Number.isFinite(quota.total) || quota.total <= 0) return null;
  if (quota.resetAt && new Date(quota.resetAt).getTime() <= now) return null;
  return Math.max(0, Math.min(1, (quota.total - quota.used) / quota.total));
}

function metric(values) {
  const known = values.filter(Number.isFinite);
  const equivalentAccounts = known.reduce((sum, value) => sum + value, 0);
  return {
    accountCount: values.length,
    knownAccounts: known.length,
    remainingPercent: known.length ? Number((equivalentAccounts / known.length * 100).toFixed(8)) : null,
    equivalentAccounts,
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
      row[name] = { applicable, remaining: applicable ? remainingFraction(quotas[name], now) : null };
    }
    if (periods.some(name => row[name].applicable && row[name].remaining === null)) unknownAccounts++;
    const plan = typeof usage?.plan === "string" ? usage.plan.trim().toLowerCase() || "unknown" : "unknown";
    if (!groups.has(plan)) groups.set(plan, []);
    groups.get(plan).push(row);
  }
  return {
    accountCount: accounts.length,
    unknownAccounts,
    generatedAt: new Date(now).toISOString(),
    groups: [...groups].map(([plan, rows]) => ({
      plan,
      accountCount: rows.length,
      depletedAccounts: rows.filter(row => row.session.remaining === 0 || row.weekly.remaining === 0).length,
      sharedWeeklyAccounts: rows.filter(row => row.sharedWeekly).length,
      session: metric(rows.filter(row => row.session.applicable).map(row => row.session.remaining)),
      weekly: metric(rows.filter(row => row.weekly.applicable).map(row => row.weekly.remaining)),
    })).sort((a, b) => a.plan.localeCompare(b.plan)),
  };
}
