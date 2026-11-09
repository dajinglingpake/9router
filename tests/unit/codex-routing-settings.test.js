import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ settings: vi.fn(), update: vi.fn(), connections: vi.fn(), catalog: vi.fn() }));
vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.settings, updateSettings: mocks.update, getProviderConnections: mocks.connections,
}));
vi.mock("@/lib/codexModels", () => ({ resolveCodexCatalog: mocks.catalog }));

import { GET, PATCH } from "@/app/api/settings/codex-routing/route.js";

const account = { id: "account", provider: "codex", isActive: true };
const request = body => new Request("http://localhost/api/settings/codex-routing", {
  method: "PATCH", body: JSON.stringify(body),
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.settings.mockResolvedValue({ localCodexRouting: { accountStrategy: "round-robin", quotaUsedPercent: 5 } });
  mocks.connections.mockResolvedValue([account, { ...account, id: "disabled", isActive: false }]);
  mocks.catalog.mockResolvedValue({ models: [{ id: "gpt-6-luna", name: "Luna" }], accounts: [] });
});

describe("Codex routing settings loading", () => {
  it("reads saved settings without waiting for slow upstream discovery", async () => {
    let finishDiscovery;
    const discovery = new Promise(resolve => { finishDiscovery = resolve; });
    mocks.catalog.mockImplementation(async (_, options) => options.cachedOnly
      ? { models: [], accounts: [] } : discovery);
    const pendingModels = GET(new Request("http://localhost/api/settings/codex-routing?models=1"));
    try {
      const response = await GET();
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toMatchObject({
        config: { accountStrategy: "round-robin", quotaUsedPercent: 5 }, models: [],
      });
      expect(mocks.catalog).toHaveBeenCalledWith([account], { respectEnabledModels: true, cachedOnly: true });
    } finally {
      finishDiscovery({ models: [], accounts: [] });
      await pendingModels;
    }
  });

  it("discovers only enabled Luna models when explicitly requested", async () => {
    mocks.catalog.mockResolvedValue({ models: [
      { id: "gpt-6-luna", name: "Luna" }, { id: "gpt-6.1-sol", name: "Sol" },
    ], accounts: [] });
    const data = await (await GET(new Request("http://localhost/api/settings/codex-routing?models=1"))).json();
    expect(data).toEqual({ models: [{ value: "gpt-6-luna", label: "Luna" }] });
    expect(mocks.catalog).toHaveBeenCalledWith([account], { respectEnabledModels: true, cachedOnly: false });
  });

  it("saves ordinary changes without model discovery and preserves existing values", async () => {
    const response = await PATCH(request({ allowCredits: true }));
    expect(response.status).toBe(200);
    expect(mocks.catalog).not.toHaveBeenCalled();
    expect(mocks.connections).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith({ localCodexRouting: expect.objectContaining({
      allowCredits: true, accountStrategy: "round-robin", quotaUsedPercent: 5,
    }) });
  });

  it("keeps an unchanged model setting when discovery is unavailable", async () => {
    mocks.catalog.mockRejectedValue(new Error("upstream unavailable"));
    const response = await PATCH(request({ quotaModelSwitch: true, quotaFallbackModel: "gpt-6-luna" }));
    expect(response.status).toBe(200);
    expect(mocks.catalog).not.toHaveBeenCalled();
  });

  it("validates a changed fallback model against the account catalog before saving", async () => {
    mocks.catalog.mockResolvedValue({ models: [{ id: "gpt-next-luna", name: "Next Luna" }], accounts: [] });
    const response = await PATCH(request({ quotaFallbackModel: "gpt-next-luna" }));
    expect(response.status).toBe(200);
    expect(mocks.catalog).toHaveBeenCalledWith([account], { respectEnabledModels: true, cachedOnly: false });
    expect(mocks.update).toHaveBeenCalled();
  });

  it("rejects a changed model that is not available, including when discovery returns empty", async () => {
    mocks.catalog.mockResolvedValue({ models: [], accounts: [] });
    const response = await PATCH(request({ quotaFallbackModel: "gpt-unavailable-luna" }));
    expect(response.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
