import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
vi.mock("open-sse/services/tokenRefresh/providers.js", () => ({ refreshCodebuddyToken: vi.fn() }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn() }));
vi.mock("@/sse/services/tokenRefresh", () => ({ updateProviderCredentials: vi.fn() }));

import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { refreshCodebuddyToken } from "open-sse/services/tokenRefresh/providers.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { updateProviderCredentials } from "@/sse/services/tokenRefresh";
import { CODEBUDDY_MODELS_CONFIG } from "open-sse/providers/registry/codebuddy-cn.js";
import { parseCodebuddyModels, resolveCodebuddyModels } from "@/lib/codebuddyModels";

const payload = {
  code: 0,
  data: {
    enterpriseId: "private-enterprise",
    agents: [
      { name: "craft", models: ["craft-only"] },
      { name: "cli", models: ["space-bunny", "space-bunny", "missing"] },
    ],
    models: [
      { id: "craft-only", name: "Craft only" },
      { id: "retired", name: "Retired" },
      { id: "hunyuan-image-alpha", tags: ["text-to-image"] },
      {
        id: "space-bunny", name: "Space-Bunny",
        maxInputTokens: 1000000, maxOutputTokens: 128000,
        supportsImages: true, supportsReasoning: true, supportsToolCall: true,
        reasoning: { supportedEfforts: ["low", "medium", "high", "xhigh", "max"] },
        privateField: "do-not-expose",
      },
    ],
  },
};
let sequence = 0;
const connection = () => ({
  id: `connection-${++sequence}`, provider: "codebuddy-cn", authType: "oauth",
  accessToken: `access-${sequence}`, refreshToken: `refresh-${sequence}`,
});

beforeEach(() => {
  vi.resetAllMocks();
  proxyAwareFetch.mockImplementation(async () => Response.json(payload));
  resolveConnectionProxyConfig.mockResolvedValue({ strictProxy: true, connectionProxyUrl: "http://proxy.test" });
  updateProviderCredentials.mockResolvedValue(true);
});
afterEach(() => vi.useRealTimers());

describe("CodeBuddy account model discovery", () => {
  it("uses only the CLI whitelist, deduplicates IDs and exposes safe model metadata", () => {
    expect(parseCodebuddyModels(payload)).toEqual([{
      id: "space-bunny", name: "Space-Bunny",
      capabilities: { vision: true, reasoning: true, tools: true, contextWindow: 1000000, maxOutput: 128000 },
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    }]);
  });

  it.each([
    { code: 1, data: payload.data },
    { code: 0, data: { models: payload.data.models } },
    { code: 0, data: { models: null } },
    { code: 0, data: { models: payload.data.models, agents: [{ name: "craft", models: ["craft-only"] }] } },
    { code: 0, data: { models: payload.data.models, agents: [{ name: "cli", models: [] }] } },
  ])("rejects unsuccessful or incomplete configuration without publishing all metadata", (body) => {
    expect(parseCodebuddyModels(body)).toEqual([]);
  });

  it("uses the account credentials, configured CLI identity and selected proxy", async () => {
    const conn = connection();
    const result = await resolveCodebuddyModels(conn);
    expect(result.models[0].id).toBe("space-bunny");
    const [url, options, proxy] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe(CODEBUDDY_MODELS_CONFIG.url);
    expect(options.headers).toMatchObject({ Authorization: `Bearer ${conn.accessToken}`, "X-IDE-Type": "CLI" });
    expect(options.headers["X-API-Key"]).toBeUndefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.redirect).toBe("error");
    expect(proxy.strictProxy).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/access-|refresh-|private-enterprise|do-not-expose/);
  });

  it("uses the API key for API-key accounts even if an old access token remains", async () => {
    const conn = { ...connection(), authType: "apikey", apiKey: "key-only" };
    await resolveCodebuddyModels(conn);
    expect(proxyAwareFetch.mock.calls[0][1].headers).toMatchObject({
      Authorization: "Bearer key-only", "X-API-Key": "key-only",
    });
    expect(refreshCodebuddyToken).not.toHaveBeenCalled();
  });

  it("refreshes expired OAuth credentials once, persists them and retries", async () => {
    proxyAwareFetch.mockResolvedValueOnce(new Response("", { status: 401 }));
    const refreshed = { accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 };
    refreshCodebuddyToken.mockResolvedValue(refreshed);
    const conn = connection();
    const result = await resolveCodebuddyModels(conn);
    expect(result.models).toHaveLength(1);
    expect(updateProviderCredentials).toHaveBeenCalledWith(conn.id, refreshed);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(proxyAwareFetch.mock.calls[1][1].headers.Authorization).toBe("Bearer new-access");
  });

  it("caches by account and credential, expires entries and supports an explicit refresh", async () => {
    vi.useFakeTimers();
    const conn = connection();
    await resolveCodebuddyModels(conn);
    await resolveCodebuddyModels(conn);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    await resolveCodebuddyModels(connection());
    await resolveCodebuddyModels({ ...conn, accessToken: "rotated-token" });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);
    await resolveCodebuddyModels(conn, { forceRefresh: true });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(CODEBUDDY_MODELS_CONFIG.cacheTtlMs + 1);
    await resolveCodebuddyModels(conn);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(5);
  });

  it.each(["http", "business", "empty", "timeout"])("returns a safe fallback warning on %s failure", async (mode) => {
    if (mode === "http") proxyAwareFetch.mockResolvedValue(new Response("secret", { status: 503 }));
    if (mode === "business") proxyAwareFetch.mockResolvedValue(Response.json({ code: 1, msg: "secret" }));
    if (mode === "empty") proxyAwareFetch.mockResolvedValue(Response.json({ code: 0, data: { models: null } }));
    if (mode === "timeout") proxyAwareFetch.mockRejectedValue(new DOMException("secret", "TimeoutError"));
    const result = await resolveCodebuddyModels(connection());
    expect(result.models).toEqual([]);
    expect(result.warning).toMatch(/built-in list/);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("does not cache failures or issue anonymous requests", async () => {
    await resolveCodebuddyModels({ id: "missing", authType: "oauth" });
    expect(proxyAwareFetch).not.toHaveBeenCalled();
    const conn = connection();
    proxyAwareFetch.mockResolvedValueOnce(new Response("", { status: 500 }));
    expect((await resolveCodebuddyModels(conn)).models).toEqual([]);
    expect((await resolveCodebuddyModels(conn)).models).toHaveLength(1);
  });
});
