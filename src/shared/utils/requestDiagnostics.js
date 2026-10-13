import { nonNegativeNumber as number, percentile, isReportedOverload } from "./diagnosticStatistics.js";
import { buildRequestPressure } from "./requestPressure.js";
import { buildAccountPerformance } from "./accountPerformance.js";
import { summarizeOutputThroughput } from "./outputThroughput.js";
export { percentile } from "./diagnosticStatistics.js";

export function isSlowResponse(record, slowMs) {
  return number(record.latencyMs) !== null && record.latencyMs >= slowMs;
}

function summarize(records, slowMs) {
  const durations = records.map(r => r.latencyMs).filter(v => number(v) !== null);
  const successes = records.filter(r => r.kind === "success");
  const firstTokens = successes.map(r => r.ttftMs).filter(v => number(v) !== null);
  const failures = records.filter(r => r.kind === "error");
  const successCount = records.filter(r => r.kind === "success").length;
  const causes = new Map();
  for (const r of failures) {
    const key = `${r.statusCode || "—"}:${r.message}`;
    const cause = causes.get(key) || { statusCode: r.statusCode, message: r.message, count: 0 };
    cause.count++;
    causes.set(key, cause);
  }
  return {
    ...summarizeOutputThroughput(records),
    recordCount: records.length, successCount, failureCount: failures.length,
    recoveredCount: failures.filter(r => r.recovered).length,
    cancelledCount: records.filter(r => r.kind === "cancelled").length,
    lastActivityAt: records.length ? Math.max(...records.map(r => r.timestamp)) : null,
    lastSuccessAt: successCount ? Math.max(...records.filter(r => r.kind === "success").map(r => r.timestamp)) : null,
    slowCount: records.filter(r => isSlowResponse(r, slowMs)).length,
    overloadCount: records.filter(isReportedOverload).length,
    errorRate: successCount + failures.length ? failures.length / (successCount + failures.length) * 100 : null,
    latencySamples: durations.length, ttftSamples: firstTokens.length,
    averageMs: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
    p95Ms: percentile(durations), ttftP50Ms: percentile(firstTokens, 0.5), ttftP95Ms: percentile(firstTokens),
    successProviders: [...new Set(successes.map(r => r.provider))],
    causes: [...causes.values()].sort((a, b) => b.count - a.count),
  };
}

function groupRecords(records, field, nameField, slowMs, connections) {
  const groups = new Map();
  for (const record of records) {
    const id = record[field];
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(record);
  }
  return [...groups].map(([id, items]) => {
    const relatedField = field === "apiKeyId" ? "connectionId" : "apiKeyId";
    const relatedName = field === "apiKeyId" ? "accountName" : "apiKeyName";
    const related = new Map();
    for (const r of items) {
      if (!related.has(r[relatedField])) related.set(r[relatedField], { id: r[relatedField], name: r[relatedName], count: 0, overloadCount: 0 });
      related.get(r[relatedField]).count++;
      if (isReportedOverload(r)) related.get(r[relatedField]).overloadCount++;
    }
    const bindings = field === "apiKeyId"
      ? connections.filter(c => c.exclusiveApiKeyIds.includes(id)).map(c => c.name)
      : connections.find(c => c.id === id)?.exclusiveApiKeyNames || [];
    return {
      id, name: items[0][nameField], providers: [...new Set(items.map(r => r.provider))],
      related: [...related.values()].sort((a, b) => b.count - a.count), bindings,
      ...summarize(items, slowMs),
    };
  }).sort((a, b) => b.failureCount - a.failureCount || b.slowCount - a.slowCount || b.recordCount - a.recordCount);
}

export function buildDiagnosticsReport(samples, options, connections = [], keys = []) {
  const { start, end, slowMs = 60000, provider = "all", model = "all", focusApiKeyId, focusConnectionId, apiKeyId, connectionId, issue = "all", page = 1, pageSize = 20 } = options;
  const comparisonRecords = samples.filter(r => r.timestamp >= start && r.timestamp < end && (provider === "all" || r.provider === provider)
    && (model === "all" || r.model === model));
  const records = comparisonRecords.filter(r => (!focusApiKeyId || r.apiKeyId === focusApiKeyId) && (!focusConnectionId || r.connectionId === focusConnectionId));
  const subjects = (configured, field, nameField) => {
    const values = new Map(samples.map(r => [r[field], { id: r[field], name: r[nameField] }]));
    configured.forEach(item => values.set(item.id, { id: item.id, name: item.name || values.get(item.id)?.name || item.id }));
    return [...values.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  };
  const bucketCount = end - start <= 6 * 3600000 ? 12 : 24;
  const bucketSize = (end - start) / bucketCount;
  const timeline = Array.from({ length: bucketCount }, (_, index) => {
    const from = start + index * bucketSize;
    const to = start + (index + 1) * bucketSize;
    return { start: from, end: to, ...summarize(records.filter(r => r.timestamp >= from && r.timestamp < to), slowMs) };
  });
  const filtered = records.filter(r => (!apiKeyId || r.apiKeyId === apiKeyId)
    && (!connectionId || r.connectionId === connectionId)
    && (issue === "all" || (issue === "slow" ? isSlowResponse(r, slowMs) : issue === "overload" ? isReportedOverload(r) : r.kind === issue)))
    .sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id));
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const byAccount = groupRecords(records, "connectionId", "accountName", slowMs, connections);
  const comparisonAccounts = focusApiKeyId || focusConnectionId ? groupRecords(comparisonRecords, "connectionId", "accountName", slowMs, connections) : byAccount;
  return {
    range: { start, end, slowMs, model },
    providers: [...new Set(samples.map(r => r.provider))].sort(),
    models: [...new Set(samples.map(r => r.model))].sort(),
    subjects: { apiKeys: subjects(keys, "apiKeyId", "apiKeyName"), accounts: subjects(connections, "connectionId", "accountName") },
    summary: summarize(records, slowMs), timeline,
    pressure: buildRequestPressure(samples, options),
    byApiKey: groupRecords(records, "apiKeyId", "apiKeyName", slowMs, connections),
    byAccount,
    accountPerformance: buildAccountPerformance(byAccount, options, connections, comparisonAccounts),
    details: filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    pagination: { page: currentPage, pageSize, total: filtered.length, totalPages },
  };
}
