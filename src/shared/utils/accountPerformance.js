import { percentile } from "./diagnosticStatistics.js";
import { summarizeOutputThroughput } from "./outputThroughput.js";

// Display rules describe retained log samples, not real-time account health or the cause of overload.
export const ACCOUNT_PERFORMANCE_RULES = {
  minAttempts: 20,
  minWaitingSamples: 20,
  stableErrorRate: 5,
  minOverloads: 5,
  frequentOverloadRate: 10,
  waitingMs: 60000,
  recentMs: 3600000,
  minSpeedSamples: 5,
  reliableSpeedSamples: 20,
  minSpeedPeers: 3,
  fasterPercent: 25,
};

export function classifyAccountPerformance(account, waitingMs = ACCOUNT_PERFORMANCE_RULES.waitingMs) {
  const rules = ACCOUNT_PERFORMANCE_RULES;
  const attempts = account.successCount + account.failureCount;
  const overloadRate = attempts ? account.overloadCount / attempts * 100 : null;
  const stability = !account.recordCount ? "empty" : !account.recentActivity ? "inactive"
    : attempts < rules.minAttempts ? "insufficient" : account.errorRate > rules.stableErrorRate ? "errors"
      : !account.recentSuccess ? "no-success" : "stable";
  return {
    stability, overloadRate,
    frequentOverload: account.overloadCount >= rules.minOverloads && overloadRate >= rules.frequentOverloadRate,
    waitingStatus: account.ttftSamples < rules.minWaitingSamples || account.ttftP95Ms == null ? "insufficient"
      : account.ttftP95Ms >= waitingMs ? "slow" : "normal",
  };
}

function compareRequestThroughput(account, peers, model) {
  const rules = ACCOUNT_PERFORMANCE_RULES;
  const provider = account.successProviders?.length === 1 ? account.successProviders[0] : null;
  const comparable = provider ? peers.filter(p => p.id !== account.id && p.id !== "unrouted"
    && p.successProviders?.length === 1 && p.successProviders[0] === provider
    && p.throughputSamples >= rules.minSpeedSamples && p.throughputMeanTps != null) : [];
  const peerMedianTps = percentile(comparable.map(p => p.throughputMeanTps), 0.5);
  const fasterPercent = peerMedianTps > 0 && account.throughputMeanTps != null ? (account.throughputMeanTps / peerMedianTps - 1) * 100 : null;
  const status = !model || model === "all" ? "select-model" : account.throughputSamples < rules.minSpeedSamples || !provider ? "insufficient"
    : comparable.length < rules.minSpeedPeers ? "no-peers" : "available";
  return {
    speedComparison: status, throughputPeerMedianTps: status === "available" ? peerMedianTps : null,
    speedPeerAccounts: status === "available" ? comparable.length : 0,
    speedFasterPercent: status === "available" ? fasterPercent : null,
    speedLimitedSample: account.throughputSamples < rules.reliableSpeedSamples,
    speedCandidate: status === "available" && fasterPercent >= rules.fasterPercent,
  };
}

export function buildAccountPerformance(groups, options, connections = [], comparisonAccounts = groups) {
  const observedUntil = Math.min(options.end, options.observedUntil ?? options.end);
  const recentStart = Math.max(options.start, observedUntil - ACCOUNT_PERFORMANCE_RULES.recentMs);
  const accounts = new Map(groups.filter(a => a.id !== "unrouted").map(a => [a.id, a]));
  for (const connection of connections) {
    if (options.provider && options.provider !== "all" && connection.provider !== options.provider) continue;
    if (options.focusConnectionId && connection.id !== options.focusConnectionId) continue;
    if (options.focusApiKeyId && !connection.exclusiveApiKeyIds?.includes(options.focusApiKeyId)) continue;
    if (accounts.has(connection.id)) continue;
    accounts.set(connection.id, {
      ...summarizeOutputThroughput([]),
      id: connection.id, name: connection.name, providers: [connection.provider].filter(Boolean),
      bindings: connection.exclusiveApiKeyNames || [], related: [], recordCount: 0,
      successCount: 0, failureCount: 0, overloadCount: 0, errorRate: null,
      ttftSamples: 0, ttftP50Ms: null, ttftP95Ms: null, successProviders: [], lastSuccessAt: null, lastActivityAt: null,
    });
  }
  return {
    observedUntil, recentStart, model: options.model || "all", rules: ACCOUNT_PERFORMANCE_RULES,
    accounts: [...accounts.values()].map(account => {
      const row = { ...account,
        recentActivity: account.lastActivityAt != null && account.lastActivityAt >= recentStart,
        recentSuccess: account.lastSuccessAt != null && account.lastSuccessAt >= recentStart };
      return { ...row, ...classifyAccountPerformance(row), ...compareRequestThroughput(row, comparisonAccounts, options.model) };
    }),
  };
}
