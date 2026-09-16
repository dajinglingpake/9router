import { afterEach, expect, it, vi } from "vitest";
import { beginOutputStream, recordOutputText, endOutputStream, getTrafficSnapshot } from "../../src/lib/runtimeTraffic.js";
import { groupActiveRequests } from "../../src/lib/activeRequestGroups.js";

afterEach(() => {
  global._runtimeTraffic.outputStreams.clear();
  vi.useRealTimers();
});

it("sums concurrent streams by account, provider and model using the total rate calculation", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
  const identities = [
    { connectionId: "a", provider: "codex", model: "sol" },
    { connectionId: "a", provider: "codex", model: "sol" },
    { connectionId: "b", provider: "codex", model: "sol" },
    { connectionId: "a", provider: "codex", model: "astra" },
    { connectionId: "a", provider: "other", model: "sol" },
  ];
  const ids = identities.map(identity => beginOutputStream(identity));
  ids.forEach(id => recordOutputText("a".repeat(80), id));
  vi.advanceTimersByTime(2000);
  const snapshot = getTrafficSnapshot();
  expect(snapshot.outputTokensPerSecond).toBe(50);
  expect(snapshot.outputGroups.map(group => group.outputTokensPerSecond)).toEqual([20, 10, 10, 10]);
  const groups = groupActiveRequests([identities[0], identities[2]], [
    { scope: "account", id: "a", queue: [{ provider: "codex", routingModel: "luna" }] },
  ], [], snapshot.outputGroups);
  expect(groups.map(group => group.outputTokensPerSecond)).toEqual([20, 10, 0]);
  ids.forEach(endOutputStream);
  vi.advanceTimersByTime(10001);
  expect(getTrafficSnapshot()).toMatchObject({ outputTokensPerSecond: 0, outputGroups: [] });
});
