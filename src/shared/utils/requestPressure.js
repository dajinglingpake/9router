import { percentile, isReportedOverload } from "./diagnosticStatistics.js";

const WINDOW_MS = 15 * 60000;
const BASELINE_MS = 7 * 86400000;
const MIN_BASELINE = 20;
const MIN_WINDOW = 5;
const MIN_WAIT_MS = 10000;

// Compare one account/model with its own earlier traffic; never infer overload from latency alone.
export function buildRequestPressure(samples, options) {
  const baselines = new Map();
  const groupKey = r => JSON.stringify([r.connectionId, r.provider, r.model]);
  for (const r of samples) {
    if (r.kind !== "success" || r.ttftMs == null || r.timestamp >= options.start || r.timestamp < options.start - BASELINE_MS) continue;
    const key = groupKey(r);
    if (!baselines.has(key)) baselines.set(key, []);
    baselines.get(key).push(r.ttftMs);
  }
  const baselineStats = new Map([...baselines].map(([key, values]) => [key, { count: values.length, p95Ms: percentile(values) }]));
  const records = samples.filter(r => r.timestamp >= options.start && r.timestamp < options.end
    && (!options.provider || options.provider === "all" || r.provider === options.provider)
    && (!options.model || options.model === "all" || r.model === options.model)
    && (!options.focusApiKeyId || r.apiKeyId === options.focusApiKeyId)
    && (!options.focusConnectionId || r.connectionId === options.focusConnectionId));
  const groups = new Map();
  for (const r of records) {
    const time = Math.floor(r.timestamp / WINDOW_MS) * WINDOW_MS;
    const key = `${groupKey(r)}:${time}`;
    if (!groups.has(key)) groups.set(key, { time, items: [] });
    groups.get(key).items.push(r);
  }
  const windows = [...groups.values()].map(({ time, items }) => {
    const first = items[0];
    const waits = items.filter(r => r.kind === "success" && r.ttftMs != null).map(r => r.ttftMs);
    const baseline = baselineStats.get(groupKey(first));
    const callers = new Map();
    for (const r of items) {
      if (!callers.has(r.apiKeyId)) callers.set(r.apiKeyId, { id: r.apiKeyId, name: r.apiKeyName, count: 0, overloadCount: 0 });
      const caller = callers.get(r.apiKeyId);
      caller.count++;
      if (isReportedOverload(r)) caller.overloadCount++;
    }
    const firstPacketMedianMs = percentile(waits, 0.5);
    const waitIncrease = waits.length >= MIN_WINDOW && baseline?.count >= MIN_BASELINE
      && firstPacketMedianMs >= MIN_WAIT_MS && firstPacketMedianMs > baseline.p95Ms;
    return { connectionId: first.connectionId, accountName: first.accountName, provider: first.provider, model: first.model,
      start: Math.max(time, options.start), end: Math.min(time + WINDOW_MS, options.end),
      overloadCount: items.filter(isReportedOverload).length,
      queueTimeoutCount: items.filter(r => r.source === "router" && r.queueTimedOut).length,
      firstPacketSamples: waits.length, firstPacketMedianMs,
      baselineSamples: baseline?.count || 0, baselineP95Ms: baseline?.count >= MIN_BASELINE ? baseline.p95Ms : null,
      waitIncrease: !!waitIncrease,
      callers: [...callers.values()].sort((a, b) => b.overloadCount - a.overloadCount || b.count - a.count) };
  }).filter(w => w.overloadCount || w.waitIncrease || w.queueTimeoutCount)
    .sort((a, b) => b.overloadCount - a.overloadCount || Number(b.waitIncrease) - Number(a.waitIncrease) || b.start - a.start);
  const overloaded = records.filter(isReportedOverload);
  const queueWaits = records.filter(r => r.kind !== "success" && r.queueWaitMs != null).map(r => r.queueWaitMs);
  return { overloadCount: overloaded.length, affectedAccounts: new Set(overloaded.map(r => r.connectionId)).size,
    affectedApiKeys: new Set(overloaded.map(r => r.apiKeyId)).size,
    queueWaitP95Ms: percentile(queueWaits), queueSamples: queueWaits.length,
    queueTimeoutCount: records.filter(r => r.queueTimedOut).length,
    waitingAnomalyWindows: windows.filter(w => w.waitIncrease).length,
    windows: windows.slice(0, 100), windowCount: windows.length,
    baselineDays: 7, minBaselineSamples: MIN_BASELINE, minWindowSamples: MIN_WINDOW, minWaitMs: MIN_WAIT_MS };
}
