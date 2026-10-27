// Locks BaseExecutor.execute retry/fallback behavior (docs 04 GAP #1, docs 11 §7).
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the network layer so we can script upstream responses.
const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { BaseExecutor } = await import("../../open-sse/executors/base.js");
const { parseRetryAfterMs } = await import("../../open-sse/utils/retryAfter.js");

function res(status, headers = {}) {
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? "" },
  };
}

function makeExec(config) {
  const ex = new BaseExecutor("test", config);
  // make headers trivial; credentials empty
  return ex;
}

const creds = { apiKey: "k" };

beforeEach(() => { fetchMock.mockReset(); });

describe("Retry-After parsing", () => {
  it("parses delay-seconds", () => {
    expect(parseRetryAfterMs({ get: () => "31" })).toBe(31000);
  });

  it("parses HTTP-date relative to the supplied clock", () => {
    const now = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
    const headers = { get: () => "Wed, 21 Oct 2015 07:28:05 GMT" };
    expect(parseRetryAfterMs(headers, now)).toBe(5000);
  });

  it("ignores malformed values", () => {
    expect(parseRetryAfterMs({ get: () => "not-a-delay" })).toBeNull();
  });
});

describe("BaseExecutor.execute — retry by status (config-driven)", () => {
  it("reports the final tier before sending upstream traffic", async () => {
    const ex = makeExec({ baseUrl: "https://x/api" });
    ex.transformRequest = () => ({ service_tier: "priority" });
    const onUpstreamRequest = vi.fn();
    fetchMock.mockImplementation(async () => {
      expect(onUpstreamRequest).toHaveBeenCalledWith({ serviceTier: "priority" });
      return res(200);
    });
    await ex.execute({ model: "m", body: { service_tier: "fast" }, credentials: creds, onUpstreamRequest });
    expect(onUpstreamRequest).toHaveBeenCalledTimes(1);
  });
  it("returns managed 503 overloads immediately without retrying or falling back", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 503: { attempts: 3, delayMs: 0 } } });
    ex.getFallbackCount = () => 2;
    const onUpstreamOverload = vi.fn();
    fetchMock.mockResolvedValue(res(503));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds, onUpstreamOverload });
    expect(out.response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onUpstreamOverload).toHaveBeenCalledTimes(1);
  });

  it("keeps pacing and overload diagnostics when using a provider transport", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 503: { attempts: 3, delayMs: 0 } } });
    const order = [];
    const directFetch = vi.fn(async () => {
      order.push("fetch");
      return new Response("no healthy upstream", { status: 503 });
    });
    fetchMock.mockImplementation((url, options) => options.directFetch(url, options));
    const onUpstreamOverload = vi.fn();
    const log = { info: vi.fn() };

    const out = await ex.execute({
      model: "m", body: {}, directFetch, log, onUpstreamOverload,
      credentials: { ...creds, beforeUpstreamRequest: async () => { order.push("pace"); } },
      onUpstreamRequest: async () => { order.push("request"); },
      diagnosticContext: { retryCount: 2, sseAttempt: 1 },
    });

    expect(order).toEqual(["pace", "request", "fetch"]);
    expect(directFetch).toHaveBeenCalledTimes(1);
    expect(onUpstreamOverload).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      upstreamStatus: 503, retryCount: 2, sseAttempt: 1, message: "no healthy upstream",
    }));
    expect(log.info).toHaveBeenCalledWith("UPSTREAM_HTTP", "test", expect.objectContaining({ upstreamStatus: 503 }));
    await expect(out.response.text()).resolves.toBe("no healthy upstream");
  });

  it.each([
    ['{"detail":"Unable to verify Daybreak Blue access. Please try again."}'],
    ['{"error":{"code":"server_is_overloaded","message":"Please try again later."}}'],
    ["no healthy upstream"],
    ["upstream connect error or disconnect/reset before headers. reset reason: connection timeout"],
  ])("preserves the upstream 503 reason and original response body: %s", async (body) => {
    const ex = makeExec({ baseUrl: "https://x/api" });
    const onUpstreamOverload = vi.fn();
    fetchMock.mockResolvedValue(new Response(body, {
      status: 503,
      statusText: "Service Unavailable",
      headers: { "x-request-id": "upstream-123" },
    }));

    const out = await ex.execute({ model: "m", body: {}, credentials: creds, onUpstreamOverload });

    expect(onUpstreamOverload).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      message: body,
      upstreamStatus: 503,
      headers: { "x-request-id": "upstream-123" },
    }));
    expect(out.response.bodyUsed).toBe(false);
    await expect(out.response.text()).resolves.toBe(body);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["access check failed: Bearer test-token sk-test-key https://example.com/private"],
    [JSON.stringify({ error: { message: "access check failed: Bearer test-token", key: "sk-test-key", url: "https://example.com/private" } })],
  ])("preserves upstream credentials and URLs in the diagnostic message: %s", async (body) => {
    const ex = makeExec({ baseUrl: "https://x/api" });
    const onUpstreamOverload = vi.fn();
    fetchMock.mockResolvedValue(new Response(body, { status: 503 }));

    const out = await ex.execute({ model: "m", body: {}, credentials: creds, onUpstreamOverload });

    expect(onUpstreamOverload).toHaveBeenCalledWith(expect.objectContaining({
      message: body,
    }));
    await expect(out.response.text()).resolves.toBe(body);
  });

  it.each(["", " \n "])("falls back to the status text only for an empty error body: %j", async (body) => {
    const ex = makeExec({ baseUrl: "https://x/api" });
    const onUpstreamOverload = vi.fn();
    fetchMock.mockResolvedValue(new Response(body, { status: 503, statusText: "Service Unavailable" }));

    await ex.execute({ model: "m", body: {}, credentials: creds, onUpstreamOverload });

    expect(onUpstreamOverload).toHaveBeenCalledWith(expect.objectContaining({ message: "Service Unavailable" }));
  });

  it("preserves the 503 status when the diagnostic body cannot be read", async () => {
    const ex = makeExec({ baseUrl: "https://x/api" });
    const onUpstreamOverload = vi.fn();
    const response = new Response("no healthy upstream", { status: 503 });
    vi.spyOn(response, "clone").mockImplementation(() => { throw new TypeError("body unavailable"); });
    fetchMock.mockResolvedValue(response);

    const out = await ex.execute({ model: "m", body: {}, credentials: creds, onUpstreamOverload });

    expect(out.response.status).toBe(503);
    expect(onUpstreamOverload).toHaveBeenCalledWith(expect.objectContaining({ message: "HTTP 503" }));
    await expect(out.response.text()).resolves.toBe("no healthy upstream");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries 502 `attempts` times then succeeds", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 3, delayMs: 0 } } });
    fetchMock
      .mockResolvedValueOnce(res(502))
      .mockResolvedValueOnce(res(502))
      .mockResolvedValueOnce(res(200));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops after exhausting 502 attempts on a single url and throws", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 2, delayMs: 0 } } });
    fetchMock.mockResolvedValue(res(502));
    // single url: 1 initial + 2 retries = 3 calls, then returns the 502 response (no fallback url)
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry before the upstream Retry-After delay", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 503: { attempts: 1, delayMs: 0 } } });
    fetchMock
      .mockResolvedValueOnce(res(503, { "retry-after": "1" }))
      .mockResolvedValueOnce(res(200));

    const originalSetTimeout = globalThis.setTimeout;
    const delays = [];
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms, ...args) => {
      delays.push(ms);
      return originalSetTimeout(fn, 0, ...args);
    });

    try {
      const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
      expect(out.response.status).toBe(200);
      expect(delays).toContain(1000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});

describe("BaseExecutor.execute — baseUrls fallback", () => {
  it("falls over to the next url on 429 (shouldRetry)", async () => {
    const ex = makeExec({ baseUrls: ["https://a/api", "https://b/api"], retry: { 429: { attempts: 0 } } });
    fetchMock
      .mockResolvedValueOnce(res(429)) // url[0] → fallback
      .mockResolvedValueOnce(res(200)); // url[1] ok
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(out.url).toBe("https://b/api");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("BaseExecutor.execute — network error retry/fallback", () => {
  it("does not retry a caller cancellation with Next.js ResponseAborted", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 3, delayMs: 0 } } });
    const caller = new AbortController();
    const reason = Object.assign(new Error(), { name: "ResponseAborted" });
    fetchMock.mockImplementationOnce(async () => {
      caller.abort(reason);
      throw reason;
    });
    await expect(ex.execute({ model: "m", body: {}, credentials: creds, signal: caller.signal })).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps network exception to 502 retry config", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 1, delayMs: 0 } } });
    fetchMock
      .mockImplementationOnce(async () => { throw new Error("ECONNRESET"); })
      .mockResolvedValueOnce(res(200));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when the only url fails with network error and no retries left", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 0 } } });
    // mockImplementationOnce (not persistent) avoids vitest flagging a reused rejection.
    fetchMock.mockImplementationOnce(async () => { throw new Error("boom"); });
    let thrown = null;
    try {
      await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    } catch (e) {
      thrown = e;
    }
    expect(thrown?.message).toBe("boom");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("BaseExecutor.execute — computeRetryDelay hook veto", () => {
  it("only invokes computeRetryDelay when status has retry config", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 503: { attempts: 1, delayMs: 0 } } });
    ex.computeRetryDelay = vi.fn().mockResolvedValue(0);
    fetchMock.mockResolvedValueOnce(res(500));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(500);
    expect(ex.computeRetryDelay).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hook returning false skips retry (uses fallback path)", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 429: { attempts: 5, delayMs: 0 } } });
    ex.computeRetryDelay = vi.fn().mockResolvedValue(false);
    fetchMock.mockResolvedValueOnce(res(429));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    // hook vetoes retry → no fallback url → returns the 429 response as-is
    expect(out.response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
