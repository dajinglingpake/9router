import { beforeEach, expect, it, vi } from "vitest";
const persistence = vi.hoisted(() => ({ save: vi.fn(async () => 1) }));
vi.mock("../../src/lib/db/repos/requestErrorsRepo.js", () => ({
  saveRequestError: persistence.save, markRequestErrorsRecovered: vi.fn(async () => {}),
  getRecentRequestErrorCount: async () => 3 + persistence.save.mock.calls.length,
}));

vi.mock("@/lib/usageDb.js", () => ({
  getActiveRequests: async () => ({ activeRequests: [] }),
  getUsageHistory: async () => [
    { timestamp: "2026-09-14T08:00:00Z", status: "200 OK" },
    { timestamp: "2026-09-14T08:00:01Z", status: "FAILED 429" },
  ],
  getRuntimeRequestErrors: () => [
    { timestamp: Date.parse("2026-09-14T08:00:02Z"), status: "FAILED 503", message: "overloaded", model: "test-model", connectionId: "account-1", provider: "codex", requestId: "outer-503", retryCount: 1 },
    { timestamp: Date.parse("2026-09-14T07:59:58Z"), status: "FAILED 401", source: "client", message: "Invalid API key" },
    { timestamp: Date.parse("2026-09-14T07:59:59Z"), status: "FAILED 499" },
  ],
}));
vi.mock("@/lib/runtimeTraffic.js", () => ({ getTrafficSnapshot: () => ({}) }));
vi.mock("@/sse/services/concurrencyLimiter.js", () => ({ getConcurrencySnapshot: () => [
  { scope: "account", id: "account-1", active: 0, queued: 1, limit: 4, state: "cooldown", cooldownRemainingMs: 25000, queue: [{ state: "cooldown", timeoutRemainingMs: 500000 }] },
] }));
vi.mock("@/lib/localDb", () => ({ getProviderConnections: async () => [{ id: "account-1", name: "Test account" }], getApiKeys: async () => [] }));

import { getSystemMetrics } from "../../src/app/api/system/metrics/route.js";
import { trackModelRequest } from "../../src/lib/runtimeModelStats.js";

beforeEach(() => {
  persistence.save.mockClear();
  globalThis._runtimeModelStats.groups.clear();
  globalThis._runtimeModelStats.errors = [];
});

it("does not list the outer 503 twice when the same attempt has upstream details", async () => {
  const tracker = trackModelRequest({}, { connectionId: "account-1", provider: "codex", model: "test-model", requestId: "outer-503" });
  tracker.onOverload({ message: "original SSE overload", retryCount: 1, sseAttempt: 4, upstreamStatus: 200 });
  const metrics = await getSystemMetrics();
  expect(metrics.requestErrors).toHaveLength(4);
  expect(metrics.requestErrors.filter(item => item.requestId === "outer-503")).toHaveLength(1);
  expect(metrics.requestErrors[0]).toMatchObject({ message: "original SSE overload", recovered: false });
});

it("includes recovered internal overloads in error details without reducing success rate", async () => {
  const before = await getSystemMetrics();
  const tracker = trackModelRequest({}, { connectionId: "account-1", provider: "codex", model: "test-model", requestId: "local-1" });
  tracker.onOverload({ message: "server_is_overloaded", upstreamStatus: 200, sseAttempt: 1 });
  tracker.onComplete();
  const after = await getSystemMetrics();
  expect(after.requestStats.successRatePercent).toBe(before.requestStats.successRatePercent);
  expect(after.requestStats.errorCount).toBe(before.requestStats.errorCount + 1);
  expect(after.requestErrors[0]).toMatchObject({ requestId: "local-1", recovered: true, transient: true, upstreamStatus: 200, message: "server_is_overloaded", account: "账号: Test account" });
});

it("counts upstream rate limits as server errors and excludes cancellations from success rate", async () => {
  const tracker = trackModelRequest({}, { connectionId: "account-1", provider: "codex", model: "test-model" });
  tracker.onOverload();
  tracker.onComplete();
  const metrics = await getSystemMetrics();
  expect(metrics.modelRequestStats).toContainEqual({ connectionId: "account-1", provider: "codex", model: "test-model", requests: 1, overloaded: 1, recovered: 1 });
  expect(metrics.requestStats).toMatchObject({ clientErrors: 1, serverErrors: 2, cancelledRequests: 1, successRatePercent: 25 });
  expect(metrics.requestErrors).toHaveLength(4);
  expect(metrics.requestErrors[0]).toMatchObject({ category: "server", message: "overloaded", account: "账号: Test account", summary: "上游服务繁忙或暂不可用" });
  expect(metrics.requestErrors[1]).toMatchObject({ category: "server", status: "FAILED 429", message: "" });
  expect(metrics.requestErrors[2]).toMatchObject({ category: "cancelled" });
  expect(metrics.requestErrors[3]).toMatchObject({ category: "client", summary: "调用密钥无效或已停用" });
  expect(metrics.concurrencyLimits[0]).toMatchObject({ state: "cooldown", cooldownRemainingMs: 25000, label: "账号: Test account", queue: [{ state: "cooldown", timeoutRemainingMs: 500000 }] });
});
