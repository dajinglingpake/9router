import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn() }));
vi.mock("@/lib/providerUsage", () => ({ refreshAndUpdateCredentials: vi.fn() }));

import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/lib/providerUsage";
import { KIMI_MODELS_CONFIG } from "open-sse/providers/registry/kimi.js";
import { parseKimiModels, resolveKimiModels } from "@/lib/kimiModels";

const payload = { data: [{
  id: "k3.1-pro", display_name: "K3.1 Pro", context_length: 1048576,
  supports_reasoning: true, supports_image_in: true, supports_video_in: true,
  reasoning: { type: "only", effort: { valid: ["low", "high", "max"] } },
  privateField: "do-not-expose",
}] };
let sequence = 0;
const connection = () => ({ id: `kimi-${++sequence}`, provider: "kimi", authType: "oauth",
  accessToken: `access-${sequence}`, refreshToken: `refresh-${sequence}`, providerSpecificData: { deviceId: "stable-device" } });

beforeEach(() => {
  vi.resetAllMocks();
  proxyAwareFetch.mockImplementation(async () => Response.json(payload));
  resolveConnectionProxyConfig.mockResolvedValue({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.test" });
  refreshAndUpdateCredentials.mockImplementation(async conn => ({ connection: conn, refreshed: false }));
});
afterEach(() => vi.useRealTimers());

describe("Kimi live model catalog", () => {
  it("preserves published names, capabilities and effort levels without private fields or duplicates", () => {
    expect(parseKimiModels({ data: [...payload.data, ...payload.data, null, { id: " " }] })).toEqual([{
      id: "k3.1-pro", name: "K3.1 Pro", kind: "llm",
      capabilities: { vision: true, videoInput: true, reasoning: true, thinkingCanDisable: false, contextWindow: 1048576 },
      supportedEffortLevels: ["low", "high", "max"],
    }]);
    expect(parseKimiModels({ data: [{ id: "next-model", display_name: {}, limit: { context: 262144 },
      think_efforts: { valid_efforts: ["high", "high", null] } }] })[0]).toMatchObject({
      id: "next-model", name: "next-model", capabilities: { contextWindow: 262144 }, supportedEffortLevels: ["high"],
    });
    expect(parseKimiModels({ data: [{ id: "fixed-thinking-model" }] })[0].supportedEffortLevels).toEqual([]);
    expect(parseKimiModels({ data: {} })).toEqual([]);
  });

  it("uses OAuth device identity, the selected proxy and a bounded request", async () => {
    const conn = connection();
    const result = await resolveKimiModels(conn);
    const [url, options, proxy] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe(KIMI_MODELS_CONFIG.url);
    expect(options).toMatchObject({ method: "GET", redirect: "error", cache: "no-store",
      headers: { Authorization: `Bearer ${conn.accessToken}`, "X-Msh-Device-Id": "stable-device" } });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(proxy).toMatchObject({ strictProxy: true, connectionProxyUrl: "http://proxy.test" });
    expect(refreshAndUpdateCredentials).toHaveBeenCalledWith(conn, false, proxy);
    expect(JSON.stringify(result)).not.toMatch(/access-|refresh-|do-not-expose|stable-device/);
  });

  it.each(["apikey", "api_key"])("uses the API key instead of stale OAuth credentials for %s", async authType => {
    await resolveKimiModels({ ...connection(), authType, apiKey: "only-key" });
    expect(proxyAwareFetch.mock.calls[0][1].headers).toEqual({ Accept: "application/json", Authorization: "Bearer only-key" });
    expect(refreshAndUpdateCredentials).not.toHaveBeenCalled();
  });

  it("refreshes a rejected OAuth token once through the shared persistence helper", async () => {
    proxyAwareFetch.mockResolvedValueOnce(new Response("", { status: 401 }));
    const conn = connection();
    const refreshed = { ...conn, accessToken: "rotated", refreshToken: "rotated-refresh" };
    refreshAndUpdateCredentials.mockResolvedValueOnce({ connection: conn }).mockResolvedValueOnce({ connection: refreshed });
    expect((await resolveKimiModels(conn)).models).toHaveLength(1);
    expect(refreshAndUpdateCredentials.mock.calls.map(call => call[1])).toEqual([false, true]);
    expect(proxyAwareFetch.mock.calls[1][1].headers.Authorization).toBe("Bearer rotated");
    await resolveKimiModels(refreshed);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it("does not treat permission denial as an expired token", async () => {
    proxyAwareFetch.mockResolvedValueOnce(new Response("private upstream details", { status: 403 }));
    const result = await resolveKimiModels(connection());
    expect(result).toEqual({ models: [], warning: expect.stringContaining("HTTP 403") });
    expect(refreshAndUpdateCredentials).toHaveBeenCalledTimes(1);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(result.warning).not.toContain("private");
  });

  it("isolates cached catalogs by account, credentials and proxy, and allows forced refresh", async () => {
    vi.useFakeTimers();
    const conn = connection();
    await resolveKimiModels(conn);
    await resolveKimiModels(conn);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    await resolveKimiModels({ ...conn, id: "another-account" });
    await resolveKimiModels({ ...conn, accessToken: "new-token" });
    await resolveKimiModels({ ...conn, providerSpecificData: { ...conn.providerSpecificData, connectionProxyUrl: "http://other.test" } });
    await resolveKimiModels(conn, { forceRefresh: true });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(5);
    vi.advanceTimersByTime(KIMI_MODELS_CONFIG.cacheTtlMs + 1);
    await resolveKimiModels(conn);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(6);
  });

  it.each(["http", "empty", "invalid-json", "timeout"])("falls back safely on %s without caching the failure", async mode => {
    if (mode === "http") proxyAwareFetch.mockResolvedValueOnce(new Response("secret", { status: 503 }));
    if (mode === "empty") proxyAwareFetch.mockResolvedValueOnce(Response.json({ data: [] }));
    if (mode === "invalid-json") proxyAwareFetch.mockResolvedValueOnce(new Response("secret"));
    if (mode === "timeout") proxyAwareFetch.mockRejectedValueOnce(new Error("secret"));
    const conn = connection();
    const result = await resolveKimiModels(conn);
    expect(result.models).toEqual([]);
    expect(result.warning).toMatch(/built-in list/);
    expect(result.warning).not.toContain("secret");
    expect((await resolveKimiModels(conn)).models).toHaveLength(1);
  });

  it("does not issue an anonymous request for a missing credential", async () => {
    await resolveKimiModels({ ...connection(), accessToken: null });
    await resolveKimiModels({ ...connection(), authType: "apikey" });
    expect(proxyAwareFetch).not.toHaveBeenCalled();
    expect(refreshAndUpdateCredentials).not.toHaveBeenCalled();
  });
});
