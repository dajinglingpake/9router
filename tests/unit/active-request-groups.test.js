import { expect, it } from "vitest";
import { groupActiveRequests } from "../../src/lib/activeRequestGroups.js";

it("attaches model totals to the matching account, including queued groups", () => {
  const stats = [
    { connectionId: "a", provider: "codex", model: "sol", requests: 42, overloaded: 8, recovered: 8 },
    { connectionId: "b", provider: "codex", model: "sol", requests: 20, overloaded: 0, recovered: 0 },
    { connectionId: "a", provider: "codex", model: "astra", requests: 7, overloaded: 5, recovered: 5 },
  ];
  const groups = groupActiveRequests([
    { connectionId: "a", provider: "codex", model: "sol", count: 1 },
    { connectionId: "b", provider: "codex", model: "sol", count: 1 },
  ], [{ scope: "account", id: "a", queue: [{ provider: "codex", routingModel: "astra" }] }], stats);
  expect(groups.map(group => group.stats)).toEqual(stats);
});

it("keeps queued GPT-6 requests out of an active GPT-5.6 group", () => {
  const queue = [
    { requestId: "same", routingModel: "gpt-5.6-sol", provider: "codex" },
    { requestId: "other", routingModel: "gpt-6-astra", provider: "codex" },
  ];
  const groups = groupActiveRequests([
    { connectionId: "a", model: "gpt-5.6-sol", provider: "codex", account: "A", count: 1, requests: [{}] },
  ], [{ scope: "account", id: "a", label: "账号: A", queue }]);
  expect(groups).toHaveLength(2);
  expect(groups[0].queue.map(item => item.requestId)).toEqual(["same"]);
  expect(groups[1]).toMatchObject({ model: "gpt-6-astra", count: 0, queue: [queue[1]] });
});

it("uses account ids and routed models even when names or upstream ids are shared", () => {
  const groups = groupActiveRequests([
    { connectionId: "a", model: "alias", provider: "codex", account: "same", count: 1 },
    { connectionId: "b", model: "alias", provider: "codex", account: "same", count: 1 },
  ], [
    { scope: "account", id: "a", label: "账号: same", queue: [] },
    { scope: "account", id: "b", label: "账号: same", queue: [{ routingModel: "alias", upstreamModel: "actual-model", provider: "codex" }] },
  ]);
  expect(groups).toHaveLength(2);
  expect(groups.map(group => group.queue.length)).toEqual([0, 1]);
});

it("groups each queued-only model once and leaves API key queues separate", () => {
  const groups = groupActiveRequests([], [
    { scope: "account", id: "a", label: "账号: A", queue: [
      { routingModel: "one", provider: "codex" },
      { routingModel: "two", provider: "codex" },
      { routingModel: "one", provider: "codex" },
    ] },
    { scope: "apiKey", id: "key", queue: [{ routingModel: "one" }] },
  ]);
  expect(groups.map(group => [group.model, group.queue.length])).toEqual([["one", 2], ["two", 1]]);
});

it("retains group metrics for five seconds with no active requests and without extending expiry", async () => {
  const { retainGroupSnapshots } = await import("../../src/lib/activeRequestGroups.js");
  const live = { connectionId: "a", provider: "codex", model: "sol", count: 2,
    requests: [{ id: "request" }], queue: [{ requestId: "queued" }], limit: { active: 2 }, outputTokensPerSecond: 42 };
  const finished = retainGroupSnapshots([live], [], 1000);
  expect(finished[0]).toEqual({ ...live, snapshotRetainedAt: 1000, count: 0, requests: [], queue: [], limit: null });
  expect(retainGroupSnapshots(finished, [], 5999)).toEqual(finished);
  expect(retainGroupSnapshots(finished, [], 6000)).toEqual([]);
  expect(retainGroupSnapshots(finished, [live], 2000)).toEqual([live]);
});

it("keeps retrying and cooling requests visible as the same group with fresh concurrency", () => {
  const active = [{ connectionId: "a", model: "sol", provider: "codex", count: 1, requests: [{ retryCount: 2 }] }];
  const running = groupActiveRequests(active, [{ scope: "account", id: "a", active: 1, limit: 3, queue: [] }]);
  expect(running[0]).toMatchObject({ retryCount: 2, count: 1, limit: { active: 1 } });
  const cooling = groupActiveRequests([], [{ scope: "account", id: "a", active: 0, limit: 3,
    queue: [{ provider: "codex", routingModel: "sol", retryCount: 3, state: "cooldown", cooldownRemainingMs: 30000 }] }]);
  expect(cooling[0]).toMatchObject({ count: 0, limit: { active: 0 }, queue: [{ retryCount: 3, state: "cooldown" }] });
});
