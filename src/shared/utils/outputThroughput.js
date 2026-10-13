import { nonNegativeNumber, percentile } from "./diagnosticStatistics.js";

// Use the entire logged duration, never total minus the legacy first-chunk timing.
export function getOutputThroughput(record) {
  if (record.kind !== "success" || record.tokenCountsEstimated === true
    || nonNegativeNumber(record.outputTokens) === null || nonNegativeNumber(record.latencyMs) === null || record.latencyMs <= 0) return null;
  const durationSeconds = record.latencyMs / 1000;
  return { totalTps: record.outputTokens / durationSeconds,
    nonReasoningTps: nonNegativeNumber(record.nonReasoningTokens) !== null && record.nonReasoningTokens <= record.outputTokens ? record.nonReasoningTokens / durationSeconds : null };
}

export function summarizeOutputThroughput(records) {
  const successes = records.filter(r => r.kind === "success" && r.tokenCountsEstimated !== true);
  const rates = successes.map(record => ({ record, rate: getOutputThroughput(record) })).filter(r => r.rate);
  const outputTokens = successes.map(r => r.outputTokens).filter(v => nonNegativeNumber(v) !== null);
  const reasoningTokens = successes.map(r => r.reasoningTokens).filter(v => nonNegativeNumber(v) !== null);
  const inputTokens = successes.map(r => r.inputTokens).filter(v => nonNegativeNumber(v) !== null);
  const measuredOutputTokens = rates.reduce((n, r) => n + r.record.outputTokens, 0);
  const measuredDurationMs = rates.reduce((n, r) => n + r.record.latencyMs, 0);
  const separated = rates.filter(r => r.rate.nonReasoningTps !== null);
  const separatedDuration = separated.reduce((n, r) => n + r.record.latencyMs, 0);
  return {
    throughputSamples: rates.length, throughputOutputTokens: measuredOutputTokens, throughputDurationMs: measuredDurationMs,
    throughputMeanTps: measuredDurationMs > 0 ? measuredOutputTokens / (measuredDurationMs / 1000) : null,
    throughputP50Tps: percentile(rates.map(r => r.rate.totalTps), 0.5),
    nonReasoningThroughputSamples: separated.length,
    nonReasoningThroughputMeanTps: separatedDuration > 0 ? separated.reduce((n, r) => n + r.record.nonReasoningTokens, 0) / (separatedDuration / 1000) : null,
    outputTokenSamples: outputTokens.length, outputTokensP50: percentile(outputTokens, 0.5), outputTokensP95: percentile(outputTokens),
    inputTokenSamples: inputTokens.length, inputTokensP50: percentile(inputTokens, 0.5),
    reasoningTokenSamples: reasoningTokens.length, reasoningTokensP50: percentile(reasoningTokens, 0.5),
    estimatedTokenSamples: records.filter(r => r.kind === "success" && r.tokenCountsEstimated === true).length,
  };
}
