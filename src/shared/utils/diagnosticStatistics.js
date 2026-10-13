export const nonNegativeNumber = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export function percentile(values, ratio = 0.95) {
  const sorted = values.filter(value => nonNegativeNumber(value) !== null).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] : null;
}

export const isReportedOverload = record => record.kind === "error" && record.source === "upstream" && ["overload", "concurrency"].includes(record.pressureSignal);
