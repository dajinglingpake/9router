import { describe, expect, it } from "vitest";
import { buildDiagnosticsReport } from "@/shared/utils/requestDiagnostics.js";
import { classifyAccountPerformance } from "@/shared/utils/accountPerformance.js";

const end = Date.parse("2026-10-13T02:00:00Z");
const options = { start: end - 24 * 3600000, end, provider: "all" };
const account = { id: "a", name: "Account A", provider: "codex", exclusiveApiKeyIds: ["key-a"], exclusiveApiKeyNames: ["Owner A"] };
const record = (patch = {}) => ({ id: "record", timestamp: end - 1000, provider: "codex", model: "model",
  connectionId: "a", accountName: "Account A", apiKeyId: "key-a", apiKeyName: "Owner A",
  kind: "success", source: "upstream", latencyMs: 90000, ttftMs: 83000, outputTokens: 1000, ...patch });
const successes = (count = 20, patch = {}) => Array.from({ length: count }, (_, i) => record({ id: `success-${i}`, ...patch }));
const overloads = count => Array.from({ length: count }, (_, i) => record({ id: `error-${i}`, kind: "error", pressureSignal: "overload", ttftMs: null }));
const report = (records, query = {}, connections = [account]) => buildDiagnosticsReport(records, { ...options, ...query }, connections).accountPerformance;

describe("account performance overview", () => {
  it("allows a reliable account to also have slow waiting, with a configurable display threshold", () => {
    const row = report(successes()).accounts[0];
    expect(row).toMatchObject({ stability: "stable", waitingStatus: "slow", frequentOverload: false, successCount: 20, ttftSamples: 20, lastSuccessAt: end - 1000 });
    expect(classifyAccountPerformance(row, 120000).waitingStatus).toBe("normal");
    expect(report(successes(20, { ttftMs: 1000 })).accounts[0]).toMatchObject({ stability: "stable", waitingStatus: "normal" });
  });
  it("does not label a small perfect sample or missing waiting measurements as healthy and fast", () => {
    expect(report(successes(19)).accounts[0]).toMatchObject({ stability: "insufficient", waitingStatus: "insufficient" });
    expect(report(successes(20, { ttftMs: null })).accounts[0]).toMatchObject({ stability: "stable", waitingStatus: "insufficient", ttftP95Ms: null });
    expect(report([]).accounts[0]).toMatchObject({ stability: "empty", waitingStatus: "insufficient", errorRate: null, overloadRate: null });
  });
  it("requires both sufficient overload reports and their proportion, not just traffic volume", () => {
    expect(report([...successes(), ...overloads(4)]).accounts[0].frequentOverload).toBe(false);
    expect(report([...successes(), ...overloads(5)]).accounts[0]).toMatchObject({ stability: "errors", frequentOverload: true, overloadRate: 20 });
    expect(report([...successes(100), ...overloads(5)]).accounts[0].frequentOverload).toBe(false);
    const generic = overloads(5).map(r => ({ ...r, pressureSignal: "unknown", statusCode: 503 }));
    expect(report([...successes(), ...generic]).accounts[0]).toMatchObject({ overloadCount: 0, frequentOverload: false, stability: "errors" });
  });
  it("separates stale success from recent reliability and shows unused configured accounts", () => {
    const rows = report(successes(100, { timestamp: end - 6 * 3600000 }), {}, [account, { ...account, id: "unused" }]).accounts;
    expect(rows.find(r => r.id === "a")).toMatchObject({ stability: "inactive", successCount: 100, recentSuccess: false });
    expect(rows.find(r => r.id === "unused")).toMatchObject({ stability: "empty", recordCount: 0 });
    expect(report([record({ connectionId: "unrouted" })], {}, []).accounts).toEqual([]);
  });
  it("does not use a recent error or cancellation to make old successful requests look currently healthy", () => {
    const history = successes(100, { timestamp: end - 2 * 3600000 });
    expect(report([...history, ...overloads(1)]).accounts[0]).toMatchObject({ stability: "no-success", recentActivity: true, recentSuccess: false });
    const row = report([...history, record({ kind: "cancelled" })]).accounts[0];
    expect(row).toMatchObject({ stability: "no-success", errorRate: 0, overloadRate: 0, cancelledCount: 1 });
    expect(report([...successes(19), record({ kind: "cancelled" })]).accounts[0].stability).toBe("insufficient");
  });
  it("anchors recency to snapshot capture time and clips short historical windows", () => {
    expect(report(successes(), { end: end + 8 * 3600000, observedUntil: end }).accounts[0].stability).toBe("stable");
    const short = report(successes(), { start: end - 60000 });
    expect(short.recentStart).toBe(end - 60000);
    expect(short.accounts[0].stability).toBe("stable");
  });
  it("preserves focus and provider scope without mixing in other accounts, callers or models", () => {
    const other = { ...account, id: "b", provider: "claude", exclusiveApiKeyIds: ["key-b"] };
    const records = [...successes(), ...overloads(5).map(r => ({ ...r, apiKeyId: "key-b" })), record({ connectionId: "b", provider: "claude", apiKeyId: "key-b" })];
    const focused = report(records, { focusApiKeyId: "key-a" }, [account, other]);
    expect(focused.accounts).toHaveLength(1);
    expect(focused.accounts[0]).toMatchObject({ stability: "stable", failureCount: 0 });
    expect(report(records, { focusConnectionId: "b" }, [account, other]).accounts.map(r => r.id)).toEqual(["b"]);
    expect(report(records, { provider: "codex" }, [account, other]).accounts.map(r => r.id)).toEqual(["a"]);
    expect(report([], { focusApiKeyId: "key-a" }, [account, other]).accounts.map(r => r.id)).toEqual(["a"]);
  });
  it("does not let detail-only filters alter the overview or include records outside the selected period", () => {
    const records = [...successes(), record({ id: "future", timestamp: end, kind: "error" })];
    expect(report(records, { issue: "error", connectionId: "b", page: 2 })).toEqual(report(records));
    expect(report(records).accounts[0].failureCount).toBe(0);
  });
});

describe("whole-request output throughput candidates", () => {
  const modelQuery = { ...options, model: "model" };
  const peerRecords = (durations = [20000, 30000, 40000]) => durations.flatMap((latencyMs, index) => successes(20, {
    connectionId: `peer-${index}`, accountName: `Peer ${index}`, apiKeyId: `peer-key-${index}`, latencyMs, ttftMs: 1000,
  }).map(r => ({ ...r, id: `peer-${index}-${r.id}` })));
  const compare = (own = successes(20, { latencyMs: 14000, ttftMs: 1000 }), peers = peerRecords(), query = {}) =>
    buildDiagnosticsReport([...own, ...peers], { ...modelQuery, ...query }, [account]);
  const ownRow = r => r.accountPerformance.accounts.find(a => a.id === "a");

  it("keeps a fast successful-response candidate even when overloads are frequent", () => {
    const row = ownRow(compare([...successes(20, { latencyMs: 14000, ttftMs: 1000 }), ...overloads(20)]));
    expect(row).toMatchObject({ speedCandidate: true, frequentOverload: true, stability: "errors",
      throughputSamples: 20, speedPeerAccounts: 3, speedLimitedSample: false });
    expect(row.throughputPeerMedianTps).toBeCloseTo(1000 / 30);
    expect(row.speedFasterPercent).toBeCloseTo(114.2857, 3);
  });
  it("requires a selected model and separates model and provider comparisons", () => {
    expect(ownRow(compare(undefined, undefined, { model: "all" }))).toMatchObject({ speedCandidate: false, speedComparison: "select-model" });
    for (const change of [{ model: "different-model" }, { provider: "claude" }]) {
      expect(ownRow(compare(undefined, peerRecords().map(r => ({ ...r, ...change }))))).toMatchObject({ speedCandidate: false, speedComparison: "no-peers" });
    }
  });
  it("uses the median of account mean throughput so one high-traffic peer cannot dominate the reference", () => {
    const peers = [...successes(1000, { connectionId: "large", latencyMs: 10000, ttftMs: 1000 }),
      ...peerRecords([30000, 40000]).map(r => ({ ...r, connectionId: `small-${r.connectionId}` }))];
    const row = ownRow(compare(successes(20, { latencyMs: 20000, ttftMs: 1000 }), peers));
    expect(row.speedCandidate).toBe(true);
    expect(row.throughputPeerMedianTps).toBeCloseTo(1000 / 30);
  });
  it("marks small samples and preserves historical throughput without claiming current availability", () => {
    expect(ownRow(compare(successes(5, { latencyMs: 10000 })))).toMatchObject({ speedCandidate: true, speedLimitedSample: true });
    expect(ownRow(compare(successes(4, { latencyMs: 10000 })))).toMatchObject({ speedCandidate: false, speedComparison: "insufficient" });
    expect(ownRow(compare(successes(20, { outputTokens: null })))).toMatchObject({ speedCandidate: false, speedComparison: "insufficient" });
    expect(ownRow(compare(successes(20, { latencyMs: 10000, timestamp: end - 2 * 3600000 })))).toMatchObject({ speedCandidate: true, stability: "inactive" });
    expect(ownRow(compare(undefined, peerRecords([20000, 30000])))).toMatchObject({ speedCandidate: false, speedComparison: "no-peers" });
  });
  it("keeps the benchmark when focusing on an account or a caller without mixing their metrics", () => {
    for (const query of [{ focusConnectionId: "a" }, { focusApiKeyId: "key-a" }]) {
      const r = compare(undefined, undefined, query);
      expect(r.summary.successCount).toBe(20);
      expect(r.accountPerformance.accounts).toHaveLength(1);
      expect(ownRow(r)).toMatchObject({ speedCandidate: true, speedPeerAccounts: 3 });
    }
  });
  it("uses only successful waits, retaining tail latency separately from the typical wait", () => {
    const records = [...successes(19, { latencyMs: 14000, ttftMs: 10000 }), record({ id: "tail", ttftMs: 80000 }),
      ...overloads(30).map(r => ({ ...r, ttftMs: 1 }))];
    expect(ownRow(compare(records))).toMatchObject({ ttftP50Ms: 10000, ttftP95Ms: 10000, ttftSamples: 20, speedCandidate: true, overloadCount: 30 });
    expect(ownRow(compare([...records, record({ id: "second-tail", ttftMs: 80000 })]))).toMatchObject({ ttftP50Ms: 10000, ttftP95Ms: 80000 });
  });
  it("applies model selection to metrics, timeline, pressure, rankings and details together", () => {
    const r = compare([...successes(20, { ttftMs: 10000 }), ...overloads(5).map(r => ({ ...r, model: "other-model" }))]);
    expect(r.summary).toMatchObject({ successCount: 80, failureCount: 0, overloadCount: 0 });
    expect(r.pressure.overloadCount).toBe(0);
    expect(r.timeline.reduce((sum, b) => sum + b.recordCount, 0)).toBe(80);
    expect(r.details.every(r => r.model === "model")).toBe(true);
    expect(r.models).toEqual(["model", "other-model"]);
    expect(r.byAccount.every(a => a.failureCount === 0)).toBe(true);
  });
  it("includes the exact improvement threshold but excludes a smaller difference", () => {
    expect(ownRow(compare(successes(20, { latencyMs: 16000 }), peerRecords([20000, 20000, 20000]))).speedCandidate).toBe(true);
    expect(ownRow(compare(successes(20, { latencyMs: 16001 }), peerRecords([20000, 20000, 20000]))).speedCandidate).toBe(false);
  });
});
