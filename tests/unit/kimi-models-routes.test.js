import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = { connection: vi.fn(), connections: vi.fn(), models: vi.fn(), disabled: vi.fn(), ping: vi.fn() };
  state.database = { getProviderConnectionById: state.connection, getProviderConnections: state.connections,
    getModelAliases: async () => ({}), getCustomModels: async () => [], getCombos: async () => [],
    getProviderNodes: async () => [], getSettings: async () => ({}), setModelAlias: vi.fn() };
  return state;
});
vi.mock("@/models", () => mocks.database);
vi.mock("@/lib/localDb", () => mocks.database);
vi.mock("@/lib/kimiModels", () => ({ resolveKimiModels: mocks.models }));
vi.mock("@/lib/codexModels", () => ({ resolveCodexCatalog: async () => ({ models: [], accounts: [] }), resolveCodexModels: vi.fn() }));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: mocks.disabled }));
vi.mock("@/sse/services/accountApiKeyAccess.js", () => ({ filterAccountPoolForRequest: async connections => connections }));
vi.mock("@/app/api/models/test/ping", () => ({ pingModelByKind: mocks.ping }));

import { GET as connectionModels } from "@/app/api/providers/[id]/models/route.js";
import { GET as dashboardModels } from "@/app/api/models/route.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import { getTrialProviders } from "@/lib/codexTrials/catalog";
import { POST as testConnectionModels } from "@/app/api/providers/[id]/test-models/route.js";

const account = { id: "kimi-account", provider: "kimi", authType: "oauth", isActive: true };
const liveModels = [{ id: "k3.1-pro", name: "K3.1 Pro", kind: "llm", supportedEffortLevels: ["low", "high", "max"],
  capabilities: { contextWindow: 1048576, vision: true, reasoning: true, thinkingCanDisable: false } },
{ id: "fixed-thinking-model", name: "Fixed Thinking Model", kind: "llm", supportedEffortLevels: [] }];
const params = { params: Promise.resolve({ id: account.id }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connections.mockImplementation(async filter => !filter?.provider || filter.provider === "kimi" ? [account] : []);
  mocks.connection.mockResolvedValue(account);
  mocks.models.mockResolvedValue({ models: liveModels });
  mocks.disabled.mockResolvedValue({});
  mocks.ping.mockResolvedValue({ ok: true, status: 200 });
});

describe("Kimi model discovery across dashboard and API", () => {
  it("returns the refreshed account catalog with provider metadata", async () => {
    const response = await connectionModels(new Request("http://localhost/api/providers/kimi-account/models"), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ provider: "kimi", models: liveModels });
    expect(mocks.models).toHaveBeenCalledWith(account, { forceRefresh: true });
  });

  it("replaces static entries in the combo picker and public model list", async () => {
    const dashboard = (await (await dashboardModels()).json()).models.filter(model => model.provider === "kimi");
    expect(dashboard.map(model => model.model)).toEqual(liveModels.map(model => model.id));
    expect(dashboard[0]).toMatchObject({ name: "K3.1 Pro", caps: { contextWindow: 1048576, vision: true } });
    const published = (await buildModelsList(["llm"])).filter(model => model.owned_by === "kimi");
    expect(published.map(model => model.id)).toEqual(liveModels.map(model => `kimi/${model.id}`));
    expect(published[0]).toMatchObject({ context_length: 1048576 });
  });

  it("respects disabled models when publishing the live catalog", async () => {
    mocks.disabled.mockResolvedValue({ kimi: ["k3.1-pro"] });
    const dashboard = (await (await dashboardModels()).json()).models.filter(model => model.provider === "kimi");
    expect(dashboard.map(model => model.model)).toEqual(["fixed-thinking-model"]);
    expect((await buildModelsList(["llm"])).filter(model => model.owned_by === "kimi").map(model => model.id))
      .toEqual(["kimi/fixed-thinking-model"]);
  });

  it("uses the same live models and effort choices in account trials without probing during polling", async () => {
    const provider = (await getTrialProviders([account], { discoverModels: true })).find(item => item.id === "kimi");
    expect(provider.models.map(model => model.id)).toEqual(liveModels.map(model => model.id));
    expect(provider.models[0].efforts).toEqual(["low", "high", "max"]);
    expect(provider.models[1].efforts).toEqual([]);
    await getTrialProviders([account]);
    expect(mocks.models).toHaveBeenCalledTimes(1);
  });

  it("runs batch connectivity tests on the live catalog", async () => {
    const response = await testConnectionModels(new Request("http://localhost/api/providers/kimi-account/test-models", { method: "POST" }), params);
    expect(response.status).toBe(200);
    expect(mocks.ping.mock.calls.map(call => call[0])).toEqual(liveModels.map(model => `kimi/${model.id}`));
  });

  it("retains the static fallback and a visible warning when discovery fails", async () => {
    mocks.models.mockResolvedValue({ models: [], warning: "Kimi catalog unavailable" });
    const data = await (await connectionModels(new Request("http://localhost/api/providers/kimi-account/models"), params)).json();
    expect(data.warning).toBe("Kimi catalog unavailable");
    expect(data.models.some(model => model.id === "k3")).toBe(true);
    const provider = (await getTrialProviders([account], { discoverModels: true })).find(item => item.id === "kimi");
    expect(provider.warning).toBe("Kimi catalog unavailable");
    expect(provider.models.some(model => model.id === "k3")).toBe(true);
    expect((await (await dashboardModels()).json()).models.some(model => model.fullModel === "kimi/k3")).toBe(true);
  });
});
