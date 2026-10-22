import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({ getProviderConnectionById: vi.fn(), getSettings: vi.fn() }));
vi.mock("@/sse/local/quotaRouting.js", () => ({ loadCodexQuotaSnapshot: vi.fn(), getAccountQuotaState: vi.fn() }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn() }));
import { createTrialSession, getTrialSession } from "@/sse/local/codexTrialSession.js";
import { handleTrialRequest } from "@/sse/local/codexTrialRetry.js";

const payload = { model: "gpt-6.1-sol", stream: true, input: [{ type: "function_call_output", call_id: "saved-file", output: "index.html written" }] };
const completed = 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","model":"gpt-6.1-sol"}}\n\n';
const success = () => new Response(completed, { headers: { "Content-Type": "text/event-stream" } });
const overload = (retryAfter = "15") => Response.json({ error: { message: "Our servers are currently overloaded." } }, {
  status: 503, headers: retryAfter === null ? {} : { "Retry-After": retryAfter },
});
let job, controller, request;
beforeEach(() => {
  vi.useFakeTimers();
  job = createTrialSession("pinned-account", payload.model, "xhigh");
  controller = new AbortController();
  request = new Request("http://localhost/v1/responses", {
    method: "POST", signal: controller.signal,
    headers: { Authorization: `Bearer ${job.token}`, "Content-Type": "application/json", "x-request-id": "initial-request" },
    body: JSON.stringify(payload),
  });
});
afterEach(async () => {
  controller.abort();
  job.revoke();
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else await new Promise(resolve => setImmediate(resolve));
  vi.useRealTimers();
});

describe("trial overload recovery", () => {
  it("waits for every cooldown beyond the CLI reconnect budget while preserving the same account and request", async () => {
    vi.useRealTimers();
    const ids = [], times = [];
    const handle = vi.fn(async attempt => {
      expect(getTrialSession(attempt)).toBe(job.session);
      expect(await attempt.json()).toEqual(payload);
      ids.push(attempt.headers.get("x-request-id")); times.push(Date.now());
      return ids.length <= 3 ? overload("1") : success();
    });
    const response = await handleTrialRequest(job.session, request, handle);
    const text = response.text();
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(handle).toHaveBeenCalledTimes(1);
    const output = await text;
    expect(handle).toHaveBeenCalledTimes(4);
    expect(output.split(completed)).toHaveLength(2);
    expect(output).not.toContain("response.failed");
    expect(new Set(ids).size).toBe(4);
    for (let index = 1; index < times.length; index++) expect(times[index] - times[index - 1]).toBeGreaterThanOrEqual(1000);
    expect(job.session).toMatchObject({ requests: 4, errors: 3, cooldownRetries: 3, cooldown: null });
    expect(job.session.models.has(payload.model)).toBe(true);
  }, 10_000);

  it("accepts an HTTP-date cooldown and keeps an hour-long wait cancellable with heartbeats", async () => {
    const handle = vi.fn(async () => overload(new Date(Date.now() + 3_600_000).toUTCString()));
    const response = await handleTrialRequest(job.session, request, handle);
    const reader = response.body.getReader();
    const heartbeat = reader.read();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(new TextDecoder().decode((await heartbeat).value)).toContain('event: ping\ndata: {"type":"ping"}');
    controller.abort();
    await expect(reader.read()).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(job.session.cooldown).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases waiting state and timers when the CLI disconnects without consuming the stream", async () => {
    const handle = vi.fn(async () => overload());
    const response = await handleTrialRequest(job.session, request, handle);
    // Exercise cancellation with a pending heartbeat blocked by backpressure.
    await vi.advanceTimersByTimeAsync(10_000);
    await response.body.cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(job.session.cooldown).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts an upstream retry and cleans up its response when the user stops", async () => {
    vi.useRealTimers();
    let upstreamSignal;
    const handle = vi.fn().mockResolvedValueOnce(overload("1")).mockImplementationOnce(async attempt => {
      upstreamSignal = attempt.signal;
      return new Promise((resolve, reject) => attempt.signal.addEventListener("abort", () => reject(attempt.signal.reason), { once: true }));
    });
    const response = await handleTrialRequest(job.session, request, handle);
    const text = response.text().catch(() => "cancelled");
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(2), { timeout: 2500 });
    controller.abort();
    expect(await text).toBe("cancelled");
    await new Promise(resolve => setImmediate(resolve));
    expect(upstreamSignal.aborted).toBe(true);
    expect(job.session.cooldown).toBeNull();
  });

  it.each([400, 401, 403, 404, 429, 503])("returns a permanent or unclassified HTTP %s error without looping", async status => {
    const handle = vi.fn(async () => Response.json({ error: { message: "terminal error" } }, { status }));
    const response = await handleTrialRequest(job.session, request, handle);
    expect(response.status).toBe(status);
    expect((await response.json()).error.message).toBe("terminal error");
    expect(handle).toHaveBeenCalledTimes(1);
    expect(job.session).toMatchObject({ requests: 1, errors: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a permanent error after cooldown as a terminal SSE error with its original message", async () => {
    vi.useRealTimers();
    const handle = vi.fn().mockResolvedValueOnce(overload("1")).mockResolvedValueOnce(Response.json({
      error: { message: "This account no longer supports the model", code: "model_not_found" },
    }, { status: 404 }));
    const response = await handleTrialRequest(job.session, request, handle);
    const text = response.text();
    const output = await text;
    expect(output).toContain('"type":"response.failed"');
    expect(output).toContain('"code":"model_not_found"');
    expect(output).toContain("[404] This account no longer supports the model");
    expect(job.session).toMatchObject({ requests: 2, errors: 2, cooldown: null });
  });
});
