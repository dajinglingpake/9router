import { beforeEach, expect, it, vi } from "vitest";
import { trackModelRequest, getModelRequestStats } from "../../src/lib/runtimeModelStats.js";

beforeEach(() => {
  globalThis._runtimeModelStats.groups.clear();
  globalThis._runtimeModelStats.requests = new WeakMap();
});

const group = { connectionId: "a", provider: "codex", model: "sol" };

it("deduplicates nested retries and counts recovery only after completion", () => {
  const request = new Request("http://localhost", { headers: { "x-request-id": "client-id" } });
  const first = trackModelRequest(request, group);
  first.onOverload();
  first.onOverload();
  const retry = trackModelRequest(request, group);
  retry.onOverload();
  expect(getModelRequestStats()).toEqual([{ ...group, requests: 1, overloaded: 1, recovered: 0 }]);
  retry.onComplete();
  retry.onComplete();
  expect(getModelRequestStats()[0]).toMatchObject({ requests: 1, overloaded: 1, recovered: 1 });
  trackModelRequest(new Request(request), group).onComplete();
  expect(getModelRequestStats()[0]).toMatchObject({ requests: 2, overloaded: 1, recovered: 1 });
});

it("keeps accounts, providers and routed models separate even for the same request", () => {
  const request = {};
  trackModelRequest(request, group).onOverload();
  trackModelRequest(request, { ...group, connectionId: "b" }).onComplete();
  trackModelRequest(request, { ...group, model: "astra" }).onComplete();
  trackModelRequest(request, { ...group, provider: "other" }).onComplete();
  const stats = getModelRequestStats();
  expect(stats).toHaveLength(4);
  expect(stats.map(item => item.overloaded)).toEqual([1, 0, 0, 0]);
  expect(stats.every(item => item.requests === 1 && item.recovered === 0)).toBe(true);
  stats[0].requests = 100;
  expect(getModelRequestStats()[0].requests).toBe(1);
});

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));
const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } = await import("../../open-sse/utils/stream.js");
const { buildOnStreamComplete } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");

it.each(["translate", "passthrough"])("%s counts completed Responses streams, but never failed or truncated ones", async (mode) => {
  for (const terminal of ["response.completed", "response.failed", "response.incomplete", null]) {
    const tracker = trackModelRequest({}, group);
    tracker.onOverload();
    const onRequestComplete = vi.fn(tracker.onComplete);
    const { onStreamComplete } = buildOnStreamComplete({ ...group, requestStartTime: Date.now(), body: {}, onRequestComplete });
    const transform = mode === "translate"
      ? createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES, "codex", null, null, "sol", "a", {}, onStreamComplete)
      : createPassthroughStreamWithLogger("codex", null, "sol", "a", {}, onStreamComplete);
    const events = [{ type: "response.created", response: { id: "r", status: "in_progress" } }];
    if (terminal) events.push({ type: terminal, response: { id: "r", status: terminal.split(".")[1] } });
    const wire = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
    await new Response(new Response(wire).body.pipeThrough(transform)).text();
    expect(onRequestComplete).toHaveBeenCalledTimes(terminal === "response.completed" ? 1 : 0);
  }
  expect(getModelRequestStats()[0]).toMatchObject({ requests: 4, overloaded: 4, recovered: 1 });
});
