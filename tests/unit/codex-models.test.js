import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), proxy: vi.fn(), refresh: vi.fn() }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: mocks.proxy }));
vi.mock("@/lib/providerUsage", () => ({ refreshAndUpdateCredentials: mocks.refresh }));

import { parseCodexModels, resolveCodexModels, resolveCodexCatalog } from "@/lib/codexModels";

const account = (id = "free", extra = {}) => ({ id, provider: "codex", accessToken: `token-${id}`,
  providerSpecificData: { chatgptAccountId: `workspace-${id}` }, ...extra });
const rawModel = (id, extra = {}) => ({ slug: id, display_name: id, visibility: "list", supported_in_api: true,
  context_window: 272000, supported_reasoning_levels: [{ effort: "high" }], ...extra });
const response = (models, status = 200) => ({ ok: status === 200, status, json: async () => ({ models }) });

beforeEach(() => {
  vi.resetAllMocks();
  globalThis.__ninerouterCodexModels.clear();
  mocks.proxy.mockResolvedValue({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.test", strictProxy: true });
  mocks.refresh.mockImplementation(async connection => ({ connection }));
  mocks.fetch.mockResolvedValue(response([rawModel("gpt-6-luna")]));
});

describe("Codex account catalog", () => {
  it("publishes only visible API models without leaking upstream instructions or inventing variants", () => {
    const models = parseCodexModels({ models: [
      rawModel("gpt-6-luna", { base_instructions: "private", input_modalities: ["text", "image"] }),
      rawModel("gpt-6-luna"), rawModel("hidden", { visibility: "hide" }),
      rawModel("unsupported", { supported_in_api: false }), { slug: 1 }, null,
    ] });
    expect(models.map(model => model.id)).toEqual(["gpt-6-luna"]);
    expect(models[0]).toMatchObject({ capabilities: { contextWindow: 272000, vision: true }, supportedEffortLevels: ["high"] });
    expect(JSON.stringify(models)).not.toContain("private");
  });

  it("uses the account workspace and proxy when reading the live API", async () => {
    const result = await resolveCodexModels(account());
    expect(result.models.map(model => model.id)).toEqual(["gpt-6-luna"]);
    expect(mocks.fetch).toHaveBeenCalledWith(expect.stringContaining("/backend-api/codex/models?client_version="), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer token-free", "ChatGPT-Account-ID": "workspace-free" }),
    }), expect.objectContaining({ connectionProxyUrl: "http://proxy.test", strictProxy: true }));
    expect(JSON.stringify(result)).not.toContain("token-free");
  });

  it("isolates account caches and deduplicates concurrent requests", async () => {
    const connection = account();
    await Promise.all([resolveCodexModels(connection), resolveCodexModels(connection)]);
    await resolveCodexModels(connection);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    await resolveCodexModels(account("pro"));
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    await resolveCodexModels({ ...connection, accessToken: "new-token" });
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
  });

  it("does not make network requests when polling cached trial catalogs", async () => {
    expect((await resolveCodexModels(account(), { cachedOnly: true })).models).toEqual([]);
    expect(mocks.fetch).not.toHaveBeenCalled();
    await resolveCodexModels(account());
    expect((await resolveCodexModels(account(), { cachedOnly: true })).models).toHaveLength(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("force refresh replaces an account's previous entitlements", async () => {
    await resolveCodexModels(account());
    mocks.fetch.mockResolvedValue(response([rawModel("new-model")]));
    expect((await resolveCodexModels(account(), { forceRefresh: true })).models.map(model => model.id)).toEqual(["new-model"]);
  });

  it("refreshes an expired token through the existing credential manager", async () => {
    const connection = account("expired", { refreshToken: "refresh-secret" });
    mocks.fetch.mockResolvedValueOnce(response([], 401)).mockResolvedValueOnce(response([rawModel("allowed")]));
    mocks.refresh.mockResolvedValueOnce({ connection }).mockResolvedValueOnce({ connection: { ...connection, accessToken: "fresh-token" } });
    expect((await resolveCodexModels(connection)).models.map(model => model.id)).toEqual(["allowed"]);
    expect(mocks.refresh).toHaveBeenLastCalledWith(connection, true, expect.anything());
    expect(mocks.fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer fresh-token");
  });

  it.each([403, 429, 500])("never substitutes static models on upstream HTTP %s", async status => {
    mocks.fetch.mockResolvedValue(response([], status));
    expect(await resolveCodexModels(account())).toMatchObject({ models: [], warning: expect.any(String) });
  });

  it("keeps unavailable accounts out when another account succeeds", async () => {
    mocks.fetch.mockImplementation(async (_url, options) => options.headers.Authorization === "Bearer token-pro"
      ? response([rawModel("gpt-6.1-sol"), rawModel("gpt-6-luna")]) : response([rawModel("gpt-6-luna")]));
    const connections = [account(), account("pro", { providerSpecificData: { enabledModels: ["gpt-6.1-sol"] } })];
    const catalog = await resolveCodexCatalog(connections, { respectEnabledModels: true });
    expect(catalog.models.map(model => [model.id, model.connectionIds])).toEqual([
      ["gpt-6-luna", ["free"]], ["gpt-6.1-sol", ["pro"]],
    ]);
  });

  it("returns an explicit warning for missing credentials, malformed or empty catalogs", async () => {
    expect(await resolveCodexModels(account("none", { accessToken: null }))).toMatchObject({ models: [], warning: expect.any(String) });
    mocks.fetch.mockResolvedValue(response([]));
    expect(await resolveCodexModels(account())).toMatchObject({ models: [], warning: expect.any(String) });
  });
});
