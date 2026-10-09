import { buildCodexQuotaSummary } from "@/lib/local/codexQuotaSummary.js";

export function isCodexPoolQuotaLow(connections, snapshots, policy) {
  if (!policy.quotaModelSwitch) return false;
  const summary = buildCodexQuotaSummary(connections, snapshots);
  if (!summary.accountCount || summary.groups.some(group => group.plan === "unknown")) return false;
  const remainingThreshold = 100 - policy.quotaUsedPercent;
  return ["session", "weekly"].some(period => {
    // Different plans have different capacities; every applicable plan must be low.
    const groups = summary.groups.filter(group => group[period].accountCount > 0);
    return groups.length > 0 && groups.every(group => {
      const quota = group[period];
      return quota.knownAccounts === quota.accountCount && quota.remainingPercent !== null
        && quota.remainingPercent <= remainingThreshold;
    });
  });
}
