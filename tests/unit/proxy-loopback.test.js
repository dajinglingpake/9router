import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("undici", () => ({
  fetch: mocks.fetch,
  Agent: class { constructor() { this.transport = "direct"; } },
  ProxyAgent: class { constructor() { this.transport = "proxy"; } },
}));

const originalFetch = globalThis.fetch;
const { proxyAwareFetch, resetDirectDispatchersForTests } = await import("open-sse/utils/proxyFetch.js");

beforeEach(() => {
  resetDirectDispatchersForTests();
  mocks.fetch.mockReset().mockResolvedValue(new Response("OK"));
  vi.stubEnv("HTTP_PROXY", "http://remote-proxy.test:7890");
  vi.stubEnv("HTTPS_PROXY", "http://remote-proxy.test:7890");
  vi.stubEnv("NO_PROXY", "");
  vi.stubEnv("no_proxy", "");
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => { globalThis.fetch = originalFetch; });

describe("internal model probes with an outbound proxy", () => {
  it.each(["127.0.0.1", "127.1.2.3", "localhost", "[::1]"])("connects directly to %s even without NO_PROXY", async host => {
    await proxyAwareFetch(`http://${host}:20128/api/v1/chat/completions`, {
      headers: { Authorization: "Bearer local-key" },
    });
    expect(mocks.fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      dispatcher: expect.objectContaining({ transport: "direct" }),
      headers: { Authorization: "Bearer local-key" },
    }));
  });

  it.each(["https://integrate.api.nvidia.com/v1/models", "http://localhost.example.com/models"])("continues proxying %s", async url => {
    await proxyAwareFetch(url);
    expect(mocks.fetch).toHaveBeenCalledWith(url, expect.objectContaining({
      dispatcher: expect.objectContaining({ transport: "proxy" }),
    }));
  });

  it("preserves an explicitly configured connection proxy", async () => {
    await proxyAwareFetch("http://127.0.0.1:20128/models", {}, {
      connectionProxyEnabled: true, connectionProxyUrl: "http://explicit-proxy.test:7890",
    });
    expect(mocks.fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      dispatcher: expect.objectContaining({ transport: "proxy" }),
    }));
  });
});
