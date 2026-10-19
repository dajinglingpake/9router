import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDiagnosticsReport, percentile } from "@/shared/utils/requestDiagnostics.js";
import { buildRequestPressure } from "@/shared/utils/requestPressure.js";
import { getRequestPressureSignal } from "@/lib/requestPressureSignals.cjs";

vi.mock("@/lib/alerts/wecom.js", () => ({ notifyRequestError: vi.fn().mockResolvedValue(undefined) }));
const start = Date.parse("2026-10-12T00:00:00.000Z"), end = start + 6 * 3600000;
const options = { start, end, slowMs: 60000, page: 1, pageSize: 20, issue: "all", provider: "all" };
const sample = (patch = {}) => ({ id: "sample", timestamp: start + 1000, provider: "codex", model: "test-model", apiKeyId: "key-a", apiKeyName: "owner",
  connectionId: "account-a", accountName: "account", kind: "success", latencyMs: null, ttftMs: null, message: "success", recovered: false, ...patch });

describe("request diagnostics aggregation", () => {
  it("does not turn missing, invalid or negative latency into zero", () => {
    expect(percentile([null, undefined, "100", -1, NaN])).toBeNull();
    expect(percentile([null, 0, 100, 200])).toBe(200);
    const report = buildDiagnosticsReport([sample(), sample({ id: "zero", latencyMs: 0 })], options);
    expect(report.summary).toMatchObject({ latencySamples: 1, p95Ms: 0, slowCount: 0 });
    expect(report.summary.ttftP95Ms).toBeNull();
  });
  it("keeps recovered failures and cancellations separate without inferring overload from a ten-second wait", () => {
    const report = buildDiagnosticsReport([
      sample({ id: "slow", latencyMs: 20000, ttftMs: 10000 }),
      sample({ id: "error", kind: "error", recovered: true, statusCode: 503, message: "overload" }),
      sample({ id: "cancelled", kind: "cancelled", statusCode: 499 }),
    ], options);
    expect(report.summary).toMatchObject({ recordCount: 3, successCount: 1, failureCount: 1, recoveredCount: 1, cancelledCount: 1, errorRate: 50, slowCount: 0, overloadCount: 0 });
  });
  it("uses a half-open range and retains distinct key identities with equal names", () => {
    const report = buildDiagnosticsReport([
      sample({ id: "before", timestamp: start - 1 }), sample({ id: "start", timestamp: start }),
      sample({ id: "other-key", apiKeyId: "key-b" }), sample({ id: "end", timestamp: end }),
    ], options);
    expect(report.summary.recordCount).toBe(2);
    expect(report.byApiKey).toHaveLength(2);
    expect(report.timeline.reduce((total, bucket) => total + bucket.recordCount, 0)).toBe(2);
  });
  it("filters and paginates details without changing the time-range overview", () => {
    const records = Array.from({ length: 25 }, (_, i) => sample({ id: `sample-${i}`, timestamp: start + i, kind: "error", message: "failed" }));
    records.push(sample({ id: "other", apiKeyId: "key-b", connectionId: "account-b" }));
    const report = buildDiagnosticsReport(records, { ...options, apiKeyId: "key-a", issue: "error", page: 2 });
    expect(report.summary.recordCount).toBe(26);
    expect(report.pagination).toMatchObject({ page: 2, total: 25, totalPages: 2 });
    expect(report.details).toHaveLength(5);
    expect(report.details.every(r => r.apiKeyId === "key-a")).toBe(true);
  });
  it("keeps recorded events consistent when drilling into a time bucket", () => {
    const records = Array.from({ length: 30 }, (_, i) => sample({ id: `record-${i}`, timestamp: start + i * 60000, kind: i % 3 ? "success" : "error" }));
    const whole = buildDiagnosticsReport(records, options);
    const bucket = whole.timeline.find(b => b.recordCount > 0);
    const focused = buildDiagnosticsReport(records, { ...options, start: bucket.start, end: bucket.end });
    expect(focused.summary.recordCount).toBe(bucket.recordCount);
    expect(focused.summary.failureCount).toBe(bucket.failureCount);
  });
  it("focuses every metric, timeline and ranking on one key across its accounts", () => {
    const records = [sample(), sample({ id: "second", connectionId: "account-b", accountName: "other account", kind: "error", latencyMs: 80000 }),
      sample({ id: "other-key", apiKeyId: "key-b", apiKeyName: "other owner", latencyMs: 1000000 })];
    const report = buildDiagnosticsReport(records, { ...options, focusApiKeyId: "key-a" });
    expect(report.summary).toMatchObject({ recordCount: 2, failureCount: 1, slowCount: 1, p95Ms: 80000 });
    expect(report.byApiKey.map(r => r.id)).toEqual(["key-a"]);
    expect(report.byAccount).toHaveLength(2);
    expect(report.timeline.reduce((sum, b) => sum + b.recordCount, 0)).toBe(2);
    expect(report.details.every(r => r.apiKeyId === "key-a")).toBe(true);
    expect(report.subjects.apiKeys).toHaveLength(2);
  });
  it("focuses an account across callers while preserving the configured selector options", () => {
    const report = buildDiagnosticsReport([sample(), sample({ id: "other-key", apiKeyId: "key-b" }), sample({ id: "other-account", connectionId: "account-b" })],
      { ...options, focusConnectionId: "account-a", apiKeyId: "key-b" },
      [{ id: "account-c", name: "disabled account", exclusiveApiKeyIds: [] }], [{ id: "key-c", name: "unused key" }]);
    expect(report.summary.recordCount).toBe(2);
    expect(report.byAccount.map(r => r.id)).toEqual(["account-a"]);
    expect(report.byApiKey).toHaveLength(2);
    expect(report.details).toHaveLength(1);
    expect(report.subjects.accounts).toContainEqual({ id: "account-c", name: "disabled account" });
    expect(report.subjects.apiKeys).toContainEqual({ id: "key-c", name: "unused key" });
  });
  it("returns an empty focused view without falling back to other callers", () => {
    const report = buildDiagnosticsReport([sample()], { ...options, focusApiKeyId: "unused" });
    expect(report.summary.recordCount).toBe(0);
    expect(report.byAccount).toEqual([]);
    expect(report.details).toEqual([]);
    expect(report.subjects.apiKeys).toHaveLength(1);
  });
});

describe("evidence-based pressure analysis", () => {
  const history = Array.from({ length: 20 }, (_, i) => sample({ id: `history-${i}`, timestamp: start - 1000 - i * 1000, latencyMs: 6000, ttftMs: 5000 }));
  const current = Array.from({ length: 5 }, (_, i) => sample({ id: `current-${i}`, timestamp: start + i * 1000, latencyMs: 30000, ttftMs: 20000 }));
  it("separates explicit upstream overload from ordinary 503, quota, router errors and long generation", () => {
    const records = [sample({ id: "long", latencyMs: 90000, ttftMs: 1000 }),
      sample({ id: "explicit", kind: "error", source: "upstream", statusCode: 503, upstreamStatus: 200, pressureSignal: "overload" }),
      sample({ id: "ordinary", kind: "error", source: "upstream", statusCode: 503, pressureSignal: "unknown" }),
      sample({ id: "quota", kind: "error", source: "upstream", statusCode: 429, pressureSignal: "quota" }),
      sample({ id: "router", kind: "error", source: "router", statusCode: 503, pressureSignal: "overload" })];
    const report = buildDiagnosticsReport(records, { ...options, issue: "overload" });
    expect(report.summary).toMatchObject({ overloadCount: 1, failureCount: 4, slowCount: 1 });
    expect(report.details.map(r => r.id)).toEqual(["explicit"]);
    expect(report.pressure).toMatchObject({ affectedAccounts: 1, affectedApiKeys: 1 });
  });
  it("requires sufficient earlier history of the same account, provider and model for a waiting anomaly", () => {
    const report = buildRequestPressure([...history, ...current], options);
    expect(report.overloadCount).toBe(0);
    expect(report.windows[0]).toMatchObject({ waitIncrease: true, baselineSamples: 20, baselineP95Ms: 5000, firstPacketMedianMs: 20000 });
    for (const field of ["connectionId", "model", "provider"]) {
      expect(buildRequestPressure([...history.map(r => ({ ...r, [field]: "different" })), ...current], options).waitingAnomalyWindows).toBe(0);
    }
    expect(buildRequestPressure([...history.slice(1), ...current], options).waitingAnomalyWindows).toBe(0);
    expect(buildRequestPressure([...history, ...current.slice(1)], options).waitingAnomalyWindows).toBe(0);
  });
  it("does not turn small normal fluctuations into waiting anomalies or use future/expired history", () => {
    expect(buildRequestPressure([...history, ...current.map(r => ({ ...r, ttftMs: 6000 }))], options).waitingAnomalyWindows).toBe(0);
    for (const timestamp of [end + 1000, start - 8 * 86400000]) {
      expect(buildRequestPressure([...history.map(r => ({ ...r, timestamp })), ...current], options).waitingAnomalyWindows).toBe(0);
    }
  });
  it("preserves a shared account baseline but limits evidence and callers to the focused key", () => {
    const other = sample({ id: "other", apiKeyId: "key-b", apiKeyName: "other caller", kind: "error", source: "upstream", pressureSignal: "overload" });
    const own = { ...other, id: "own", apiKeyId: "key-a", apiKeyName: "owner" };
    const report = buildRequestPressure([...history.map(r => ({ ...r, apiKeyId: "key-b" })), ...current, other, own], { ...options, focusApiKeyId: "key-a" });
    expect(report.overloadCount).toBe(1);
    expect(report.windows[0].baselineSamples).toBe(20);
    expect(report.windows[0].callers.map(c => c.id)).toEqual(["key-a"]);
  });
  it("classifies sanitized structured overload codes without needing upstream bodies", () => {
    expect(getRequestPressureSignal({ upstreamErrorCode: "server_is_overloaded" })).toBe("overload");
    expect(getRequestPressureSignal({ message: JSON.stringify({ code: "server_is_overloaded", type: "service_unavailable_error" }) })).toBe("overload");
    expect(getRequestPressureSignal({ message: "Too many concurrent requests" })).toBe("concurrency");
    expect(getRequestPressureSignal({ message: "insufficient_quota" })).toBe("quota");
    expect(getRequestPressureSignal({ message: "service_unavailable_error" })).toBe("unknown");
    expect(getRequestPressureSignal({ networkCode: "ETIMEDOUT" })).toBe("network");
  });
  it("keeps queue evidence separate and measures only failures with recorded wait times", () => {
    const report = buildRequestPressure([sample({ kind: "error", source: "router", queueTimedOut: true, queueWaitMs: 300000 }), sample()], options);
    expect(report).toMatchObject({ overloadCount: 0, queueTimeoutCount: 1, queueSamples: 1, queueWaitP95Ms: 300000 });
    expect(report.windows[0].overloadCount).toBe(0);
  });
});

describe("current account labels in diagnostics", () => {
  const markedAt = "2026-10-14T02:00:00.000Z";
  const green = { qualityStatus: "custom", qualityLabel: "申诉后已恢复", qualityColor: "#15803d", qualityMarkedAt: markedAt };
  const connections = [
    { id: "account-a", name: "recovered", provider: "codex", exclusiveApiKeyIds: [], ...green },
    { id: "account-b", name: "under review", provider: "codex", exclusiveApiKeyIds: [], qualityStatus: "custom", qualityLabel: "申诉中", qualityColor: "#facc15", qualityMarkedAt: markedAt },
    { id: "account-empty", name: "disabled without logs", provider: "codex", isActive: false, exclusiveApiKeyIds: [], ...green },
    { id: "account-unmarked", name: "unmarked", provider: "codex", exclusiveApiKeyIds: [] },
  ];
  const records = [sample({ id: "green-success", latencyMs: 1000 }),
    sample({ id: "green-error", kind: "error", source: "upstream", pressureSignal: "overload" }),
    sample({ id: "yellow-error", connectionId: "account-b", kind: "error", source: "upstream", pressureSignal: "overload", apiKeyId: "key-b" }),
    sample({ id: "unmarked", connectionId: "account-unmarked" }), sample({ id: "deleted", connectionId: "deleted-account" }), sample({ id: "unrouted", connectionId: "unrouted" })];

  it("shows the same safe label metadata in every account view, including accounts with no records", () => {
    const report = buildDiagnosticsReport(records, options, connections);
    expect(report.byAccount.find(a => a.id === "account-a")).toMatchObject(green);
    expect(report.accountPerformance.accounts.find(a => a.id === "account-empty")).toMatchObject({ ...green, recordCount: 0 });
    expect(report.byApiKey.find(k => k.id === "key-a").related.find(a => a.id === "account-a")).toMatchObject(green);
    expect(report.subjects.accounts.find(a => a.id === "account-a")).toMatchObject(green);
    expect(report.details.find(r => r.id === "green-error")).toMatchObject(green);
    expect(report.pressure.windows.find(w => w.connectionId === "account-a")).toMatchObject(green);
  });

  it.each([{ accountColor: "#15803D" }, { accountLabel: "label:申诉后已恢复" }])("filters all metrics, charts, rankings and details together: %j", filter => {
    const report = buildDiagnosticsReport(records, { ...options, ...filter }, connections);
    expect(report.summary).toMatchObject({ recordCount: 2, failureCount: 1, overloadCount: 1 });
    expect(report.timeline.reduce((total, bucket) => total + bucket.recordCount, 0)).toBe(2);
    expect(report.byAccount.map(a => a.id)).toEqual(["account-a"]);
    expect(report.byApiKey.map(k => k.id)).toEqual(["key-a"]);
    expect(report.details.map(r => r.id).sort()).toEqual(["green-error", "green-success"]);
    expect(report.pressure).toMatchObject({ overloadCount: 1, affectedAccounts: 1, affectedApiKeys: 1 });
    expect(report.accountPerformance.accounts.map(a => a.id).sort()).toEqual(["account-a", "account-empty"]);
    expect(report.accountLabels).toEqual(expect.arrayContaining(["申诉后已恢复", "申诉中"]));
    expect(report.accountColors).toEqual(["#15803d", "#facc15"]);
  });

  it("combines labels, colors, focus and detail pagination without falling back on other accounts", () => {
    const many = Array.from({ length: 25 }, (_, i) => sample({ id: `green-${i}`, timestamp: start + i, kind: "error" }));
    const report = buildDiagnosticsReport([...records, ...many], { ...options, accountColor: "#15803d", accountLabel: "marked", focusApiKeyId: "key-a", issue: "error", page: 2 }, connections);
    expect(report.summary.recordCount).toBe(27);
    expect(report.pagination).toMatchObject({ page: 2, total: 26, totalPages: 2 });
    expect(report.details).toHaveLength(6);
    expect(report.details.every(r => r.connectionId === "account-a")).toBe(true);
    const empty = buildDiagnosticsReport(records, { ...options, accountColor: "#15803d", accountLabel: "label:申诉中", focusConnectionId: "account-b" }, connections);
    expect(empty.summary.recordCount).toBe(0);
    expect(empty.accountPerformance.accounts).toEqual([]);
    expect(empty.byApiKey).toEqual([]);
    expect(empty.details).toEqual([]);
    expect(empty.accountColors).toEqual(report.accountColors);
  });

  it("includes deleted and unrouted records only in the unmarked or all-label scope", () => {
    const unmarked = buildDiagnosticsReport(records, { ...options, accountLabel: "unmarked" }, connections);
    expect(unmarked.details.map(r => r.id).sort()).toEqual(["deleted", "unmarked", "unrouted"]);
    expect(buildDiagnosticsReport(records, { ...options, accountLabel: "marked" }, connections).summary.recordCount).toBe(3);
  });

  it("preserves history needed for waiting baselines while applying a color and key filter", () => {
    const history = Array.from({ length: 20 }, (_, i) => sample({ id: `history-${i}`, timestamp: start - i - 1, ttftMs: 1000, apiKeyId: "history-key" }));
    const current = Array.from({ length: 5 }, (_, i) => sample({ id: `current-${i}`, ttftMs: 20000 }));
    const report = buildDiagnosticsReport([...history, ...current, ...records], { ...options, accountColor: "#15803d", focusApiKeyId: "key-a" }, connections);
    expect(report.pressure.windows[0]).toMatchObject({ ...green, waitIncrease: true, baselineSamples: 20 });
    expect(report.pressure.windows.every(w => w.connectionId === "account-a")).toBe(true);
    expect(report.pressure.windows[0].callers.map(k => k.id)).toEqual(["key-a"]);
  });
});

describe("request diagnostics API", () => {
  const originalDataDir = process.env.DATA_DIR;
  const originalSnapshotFile = process.env.DIAGNOSTICS_SNAPSHOT_FILE;
  let tempDir, db, adapter, api, diagnostics, owner, other, privateAccount, sharedAccount, listeners;
  beforeEach(async () => {
    listeners = Object.fromEntries(["beforeExit", "exit", "SIGINT", "SIGTERM"].map(event => [event, new Set(process.rawListeners(event))]));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-diagnostics-"));
    process.env.DATA_DIR = tempDir;
    delete process.env.DIAGNOSTICS_SNAPSHOT_FILE;
    delete global._dbAdapter;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    await db.initDb();
    adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    owner = await db.createApiKey("Owner", "test-machine");
    other = await db.createApiKey("Other", "test-machine");
    privateAccount = await db.createProviderConnection({ provider: "codex", authType: "oauth", name: "Dedicated account", accessToken: "private-access-token", refreshToken: "private-refresh-token", exclusiveApiKeyIds: [owner.id] });
    sharedAccount = await db.createProviderConnection({ provider: "claude", authType: "oauth", name: "Shared account", accessToken: "another-private-access-token" });
    await db.saveRequestUsage({ timestamp: new Date(start + 1000).toISOString(), provider: "codex", model: "test-model", connectionId: privateAccount.id, apiKey: owner.key, tokens: { prompt_tokens: 1, completion_tokens: 1 }, latency: { total: 120000, ttft: 15000 } });
    await db.saveRequestUsage({ timestamp: new Date(start + 2000).toISOString(), provider: "claude", model: "test-model", connectionId: sharedAccount.id, apiKey: other.key, tokens: { prompt_tokens: 1, completion_tokens: 1 }, latency: { total: 2000, ttft: 100 } });
    diagnostics = await import("@/lib/requestDiagnostics.js");
    api = await import("@/app/api/usage/diagnostics/route.js");
  });
  afterEach(async () => {
    await global._requestErrorWrites?.pending;
    global._dbAdapter?.instance?.close?.();
    delete global._dbAdapter;
    for (const [event, original] of Object.entries(listeners)) for (const listener of process.rawListeners(event)) if (!original.has(listener)) process.removeListener(event, listener);
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = originalDataDir;
    if (originalSnapshotFile === undefined) delete process.env.DIAGNOSTICS_SNAPSHOT_FILE; else process.env.DIAGNOSTICS_SNAPSHOT_FILE = originalSnapshotFile;
  });
  function request(extra = {}) {
    return new Request("http://localhost/api/usage/diagnostics?" + new URLSearchParams({ start: new Date(start).toISOString(), end: new Date(end).toISOString(), ...extra }));
  }
  it("joins real usage and error records, deduplicates attempts and exposes dedicated owners", async () => {
    const errors = await import("@/lib/db/repos/requestErrorsRepo.js");
    const entry = { timestamp: start + 3000, provider: "codex", model: "test-model", connectionId: privateAccount.id, apiKeyId: owner.id, apiKeyName: owner.name,
      requestId: "same-request", status: "FAILED 503", source: "upstream", latencyMs: 65000, message: "private upstream body", transient: true };
    const id = await errors.saveRequestError(entry);
    await errors.saveRequestError(entry);
    adapter.run("UPDATE requestErrors SET recovered = 1 WHERE id = ?", [id]);
    await errors.saveRequestError({ ...entry, requestId: "cancel-request", timestamp: start + 4000, status: "FAILED 499", latencyMs: null });
    const response = await api.GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const report = await response.json();
    expect(report.summary).toMatchObject({ recordCount: 4, successCount: 2, failureCount: 1, recoveredCount: 1, cancelledCount: 1, slowCount: 2 });
    expect(report.byAccount.find(a => a.id === privateAccount.id).bindings).toEqual(["Owner"]);
    expect(report.byApiKey.find(k => k.id === owner.id).bindings).toEqual(["Dedicated account"]);
    for (const secret of [owner.key, other.key, "private-access-token", "private-refresh-token", "private upstream body"]) expect(JSON.stringify(report)).not.toContain(secret);
  });
  it("filters provider and detail scope while keeping provider options available", async () => {
    const report = await (await api.GET(request({ provider: "codex", apiKeyId: owner.id }))).json();
    expect(report.summary.recordCount).toBe(1);
    expect(report.providers).toEqual(["claude", "codex"]);
    expect(report.details[0]).toMatchObject({ apiKeyName: "Owner", accountName: "Dedicated account", latencyMs: 120000, ttftMs: 15000 });
  });
  it("applies the focus parameters to the complete API report", async () => {
    const report = await (await api.GET(request({ focusApiKeyId: owner.id }))).json();
    expect(report.summary.recordCount).toBe(1);
    expect(report.byAccount.map(r => r.id)).toEqual([privateAccount.id]);
    expect(report.timeline.reduce((sum, b) => sum + b.recordCount, 0)).toBe(1);
    expect(report.subjects.apiKeys.map(k => k.id)).toContain(other.id);
    const account = await (await api.GET(request({ focusConnectionId: sharedAccount.id }))).json();
    expect(account.summary.p95Ms).toBe(2000);
    expect(account.byApiKey.map(r => r.id)).toEqual([other.id]);
  });
  it("reads trial details without letting unrelated traffic or seven-day history consume the row limit", async () => {
    const errors = await import("@/lib/db/repos/requestErrorsRepo.js");
    const entry = { timestamp: start + 3000, provider: "codex", model: "test-model", connectionId: privateAccount.id,
      requestId: "trial-request", status: "FAILED 503", source: "upstream", message: "server is overloaded", apiKeyId: owner.id };
    await errors.saveRequestError(entry);
    await errors.saveRequestError(entry);
    // More unrelated rows than the report limit, split between another account and another model.
    adapter.run(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 20001)
      INSERT INTO usageHistory(timestamp, provider, model, connectionId)
      SELECT ?, 'codex', CASE WHEN x % 2 = 0 THEN 'other-model' ELSE 'test-model' END,
        CASE WHEN x % 2 = 0 THEN ? ELSE ? END FROM n`, [new Date(start + 5000).toISOString(), privateAccount.id, sharedAccount.id]);
    adapter.run(`INSERT INTO requestErrors(timestamp, provider, model, connectionId, category, data)
      SELECT ?, provider, model, connectionId, 'upstream', '{}' FROM usageHistory WHERE timestamp = ?`, [start + 5000, new Date(start + 5000).toISOString()]);
    adapter.run(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 20001)
      INSERT INTO usageHistory(timestamp, provider, model, connectionId)
      SELECT ?, 'codex', 'test-model', ? FROM n`, [new Date(start - 1000).toISOString(), privateAccount.id]);
    const scoped = { ...options, provider: "codex", model: "test-model", focusConnectionId: privateAccount.id, detailsOnly: true };
    const report = await diagnostics.getRequestDiagnostics(scoped);
    expect(report.truncated).toBe(false);
    expect(report.pagination.total).toBe(2);
    expect(report.details.map(r => r.kind)).toEqual(["error", "success"]);
    expect(report.details.every(r => r.connectionId === privateAccount.id && r.model === "test-model")).toBe(true);
    expect(report.summary).toBeUndefined();
    expect(report.pressure).toBeUndefined();
    expect(report.accountPerformance).toBeUndefined();
    const failed = await diagnostics.getRequestDiagnostics({ ...scoped, issue: "error" });
    expect(failed.pagination.total).toBe(1);
    expect(failed.details[0].statusCode).toBe(503);
    const second = await diagnostics.getRequestDiagnostics({ ...scoped, page: 2, pageSize: 1 });
    expect(second.pagination).toMatchObject({ total: 2, page: 2, totalPages: 2 });
    expect(second.details[0].kind).toBe("success");
    for (const secret of [owner.key, other.key, "private-access-token", "private-refresh-token"]) expect(JSON.stringify(report)).not.toContain(secret);
  });
  it("reads current custom labels and colors from the database without exposing credentials", async () => {
    const quality = { qualityStatus: "custom", qualityLabel: "风控已结束，恢复正常", qualityColor: "#15803d", qualityMarkedAt: "2026-10-14T02:00:00.000Z" };
    await db.updateProviderConnection(privateAccount.id, { ...quality, isActive: false });
    const report = await (await api.GET(request({ accountColor: "#15803D" }))).json();
    expect(report.range.accountColor).toBe("#15803d");
    expect(report.summary.recordCount).toBe(1);
    expect(report.byAccount[0]).toMatchObject(quality);
    expect(report.details[0]).toMatchObject(quality);
    expect(report.accountPerformance.accounts[0]).toMatchObject(quality);
    expect(report.subjects.accounts.find(a => a.id === privateAccount.id)).toMatchObject(quality);
    for (const secret of [owner.key, other.key, "private-access-token", "private-refresh-token"]) expect(JSON.stringify(report)).not.toContain(secret);
    expect((await db.getProviderConnectionById(privateAccount.id)).isActive).toBe(false);
    await db.updateProviderConnection(privateAccount.id, { qualityLabel: "再次观察", qualityColor: "#123456" });
    const refreshed = await (await api.GET(request({ accountLabel: "label:再次观察", accountColor: "#123456" }))).json();
    expect(refreshed.summary.recordCount).toBe(1);
    expect(refreshed.details[0]).toMatchObject({ qualityLabel: "再次观察", qualityColor: "#123456" });
    expect((await (await api.GET(request({ accountLabel: `label:${quality.qualityLabel}` }))).json()).summary.recordCount).toBe(0);
  });
  it("keeps legacy labels orange and respects explicitly cleared or malformed label data", async () => {
    await db.updateProviderConnection(privateAccount.id, { isDegraded: true, degradedMarkedAt: "2026-10-13T07:00:00.000Z" });
    const legacy = await (await api.GET(request({ accountColor: "#a64027" }))).json();
    expect(legacy.byAccount[0]).toMatchObject({ qualityStatus: "degraded", qualityLabel: "已降智", qualityColor: "#a64027", qualityMarkedAt: "2026-10-13T07:00:00.000Z" });
    await db.updateProviderConnection(privateAccount.id, { qualityStatus: null });
    expect((await (await api.GET(request({ accountLabel: "marked" }))).json()).summary.recordCount).toBe(0);
    await db.updateProviderConnection(privateAccount.id, { qualityStatus: "custom", qualityLabel: { text: "not a string" }, qualityColor: "#15803d" });
    expect((await (await api.GET(request({ accountLabel: "marked" }))).json()).summary.recordCount).toBe(0);
    adapter.run("UPDATE providerConnections SET data = ? WHERE id = ?", ["invalid JSON", privateAccount.id]);
    const invalid = await (await api.GET(request({ accountLabel: "unmarked" }))).json();
    expect(invalid.summary.recordCount).toBe(2);
    expect(invalid.accountLabels).toEqual([]);
  });
  it("applies model selection from the API query and keeps model options available", async () => {
    const report = await (await api.GET(request({ model: "test-model" }))).json();
    expect(report.range.model).toBe("test-model");
    expect(report.summary.recordCount).toBe(2);
    expect(report.details.every(r => r.model === "test-model")).toBe(true);
    const empty = await (await api.GET(request({ model: "unused-model" }))).json();
    expect(empty.summary.recordCount).toBe(0);
    expect(empty.models).toEqual(report.models);
  });
  it("reads full-request and reasoning throughput from safe usage metadata", async () => {
    adapter.run("UPDATE usageHistory SET tokens = ?, promptTokens = 2000, completionTokens = 1000, meta = ? WHERE connectionId = ?", [
      JSON.stringify({ prompt_tokens: 2000, completion_tokens: 1000, reasoning_tokens: 600 }),
      JSON.stringify({ latency: { total: 20000, ttft: 19999 } }), privateAccount.id,
    ]);
    const report = await (await api.GET(request({ provider: "codex" }))).json();
    expect(report.summary).toMatchObject({ throughputMeanTps: 50, throughputSamples: 1, nonReasoningThroughputMeanTps: 20, reasoningTokenSamples: 1 });
    expect(report.details[0]).toMatchObject({ inputTokens: 2000, outputTokens: 1000, reasoningTokens: 600, nonReasoningTokens: 400 });
  });
  it("does not expose sensitive values stored in purported numeric token fields", async () => {
    adapter.run("UPDATE usageHistory SET tokens = ?", [JSON.stringify({ prompt_tokens: owner.key, completion_tokens: other.key, reasoning_tokens: "private-token-metadata", privateField: "private-token-payload" })]);
    const report = await (await api.GET(request())).json();
    for (const secret of [owner.key, other.key, "private-token-metadata", "private-token-payload"]) expect(JSON.stringify(report)).not.toContain(secret);
    expect(report.details.every(r => r.reasoningTokens === null && r.outputTokens === 1)).toBe(true);
  });
  it("always reads the runtime database even when an obsolete preview setting exists", async () => {
    process.env.DIAGNOSTICS_SNAPSHOT_FILE = path.join(tempDir, "missing.json");
    const response = await api.GET(request());
    expect(response.status).toBe(200);
    const report = await response.json();
    expect(report.source).toEqual({ kind: "live" });
    expect(report.summary.recordCount).toBe(2);
    expect(adapter.get("SELECT COUNT(*) AS count FROM usageHistory").count).toBe(2);
  });
  it("handles invalid historical JSON and missing latency without failing the report", async () => {
    adapter.run("UPDATE usageHistory SET meta = ?", ["not-json"]);
    const report = await (await api.GET(request())).json();
    expect(report.summary.latencySamples).toBe(0);
    expect(report.summary.p95Ms).toBeNull();
    expect(report.details.every(r => r.latencyMs === null)).toBe(true);
  });
  it("excludes complete-response legacy latency from the start-response timing", async () => {
    adapter.run("UPDATE usageHistory SET meta = ?", [JSON.stringify({ latency: { total: 20000, ttft: 20000 } })]);
    const report = await (await api.GET(request())).json();
    expect(report.summary).toMatchObject({ ttftSamples: 0, ttftP95Ms: null, slowCount: 0, overloadCount: 0 });
    expect(report.details.every(r => r.ttftMs === null)).toBe(true);
  });
  it("reads earlier usage for a baseline without adding historical requests to the selected overview", async () => {
    for (let i = 0; i < 20; i++) await db.saveRequestUsage({ timestamp: new Date(start - 1000 - i * 1000).toISOString(), provider: "codex", model: "test-model", connectionId: privateAccount.id, apiKey: owner.key, latency: { total: 6000, ttft: 5000 } });
    for (let i = 0; i < 4; i++) await db.saveRequestUsage({ timestamp: new Date(start + 3000 + i * 1000).toISOString(), provider: "codex", model: "test-model", connectionId: privateAccount.id, apiKey: owner.key, latency: { total: 30000, ttft: 20000 } });
    const report = await (await api.GET(request({ focusConnectionId: privateAccount.id }))).json();
    expect(report.summary.recordCount).toBe(5);
    expect(report.pressure.windows[0]).toMatchObject({ waitIncrease: true, baselineSamples: 20, firstPacketSamples: 5 });
  });
  it("keeps deleted raw keys distinct and never returns their values", async () => {
    await db.deleteApiKey(owner.id);
    await db.deleteApiKey(other.id);
    const report = await (await api.GET(request())).json();
    expect(report.byApiKey).toHaveLength(2);
    expect(new Set(report.byApiKey.map(r => r.id)).size).toBe(2);
    expect(JSON.stringify(report)).not.toContain(owner.key);
    expect(JSON.stringify(report)).not.toContain(other.key);
  });
  it.each([
    { start: "not-a-date" }, { end: new Date(start).toISOString() }, { end: new Date(start + 32 * 86400000).toISOString() },
    { slowMs: "NaN" }, { slowMs: "0" }, { page: "0" }, { page: "1.5" }, { issue: "invalid" }, { focusApiKeyId: "key", focusConnectionId: "account" },
    { accountLabel: "invalid" }, { accountLabel: "label:" }, { accountLabel: "label:   " }, { accountLabel: `label:${"字".repeat(81)}` },
    { accountColor: "green" }, { accountColor: "#fff" }, { accountColor: "#15803d\n" },
  ])("rejects invalid query parameters: %j", async query => {
    expect((await api.GET(request(query))).status).toBe(400);
  });
  it("returns a safe empty result and validates the default time range", async () => {
    const report = await (await api.GET(request({ start: new Date(end).toISOString(), end: new Date(end + 1000).toISOString() }))).json();
    expect(report.summary).toMatchObject({ recordCount: 0, p95Ms: null, errorRate: null });
    expect(report.details).toEqual([]);
    expect(diagnostics.parseDiagnosticsQuery(new URLSearchParams(), end)).toMatchObject({ start, end, slowMs: 60000 });
  });
});
