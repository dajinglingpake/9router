import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = {
  connection: vi.fn(), connections: vi.fn(), catalog: vi.fn(), models: vi.fn(), access: vi.fn(),
  aliases: vi.fn(), custom: vi.fn(), disabled: vi.fn(), ping: vi.fn(), combos: vi.fn(),
  };
  state.database = { getProviderConnectionById: state.connection, getProviderConnections: state.connections,
  getModelAliases: state.aliases, getCustomModels: state.custom, getCombos: state.combos,
  getProviderNodes: async () => [], getSettings: async () => ({}), updateSettings: vi.fn(), setModelAlias: vi.fn() };
  return state;
});
vi.mock("@/models", () => mocks.database);
vi.mock("@/lib/localDb", () => mocks.database);
vi.mock("@/lib/codexModels", () => ({ resolveCodexCatalog: mocks.catalog, resolveCodexModels: mocks.models }));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: mocks.disabled }));
vi.mock("@/sse/services/accountApiKeyAccess.js", () => ({ filterAccountPoolForRequest: mocks.access }));
vi.mock("@/app/api/models/test/ping", () => ({ pingModelByKind: mocks.ping }));

import { GET as connectionModels } from "@/app/api/providers/[id]/models/route.js";
import { GET as dashboardModels } from "@/app/api/models/route.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import { getTrialProviders } from "@/lib/codexTrials/catalog";
import { GET as routingSettings } from "@/app/api/settings/codex-routing/route.js";
import { GET as geminiModels } from "@/app/api/v1beta/models/route.js";
import { POST as testConnectionModels } from "@/app/api/providers/[id]/test-models/route.js";

const free = { id: "free", provider: "codex", isActive: true };
const pro = { id: "pro", provider: "codex", isActive: true, exclusiveApiKeyIds: ["owner"] };
const model = (id, connectionIds) => ({ id, name: id, kind: "llm", connectionIds,
  supportedEffortLevels: ["high"], capabilities: { contextWindow: 272000, maxOutput: 64000 } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connections.mockResolvedValue([free, pro]);
  mocks.connection.mockResolvedValue(free);
  mocks.aliases.mockResolvedValue({ fake: "cx/not-authorized" });
  mocks.custom.mockResolvedValue([{ providerAlias: "cx", id: "not-authorized" }]);
  mocks.combos.mockResolvedValue([]);
  mocks.disabled.mockResolvedValue({});
  mocks.access.mockImplementation(async (connections, request) => request?.headers.get("x-owner") === "yes" ? connections : connections.filter(connection => connection.id === "free"));
  mocks.catalog.mockImplementation(async connections => ({ models: [
    ...(connections.some(connection => connection.id === "free") ? [model("gpt-6-luna", ["free"])] : []),
    ...(connections.some(connection => connection.id === "pro") ? [model("gpt-6.1-sol", ["pro"])] : []),
  ], accounts: [] }));
  mocks.models.mockResolvedValue({ models: [model("gpt-6-luna", ["free"])] });
  mocks.ping.mockResolvedValue({ success: true });
});

describe("Codex live catalogs across endpoints", () => {
  it("uses the accessible live catalog for the Gemini compatible model list", async () => {
    const request = new Request("http://localhost/v1beta/models");
    const data = await (await geminiModels(request)).json();
    expect(data.models.filter(model => model.name.startsWith("models/cx/")))
      .toEqual([expect.objectContaining({ name: "models/cx/gpt-6-luna" })]);
    expect(mocks.catalog).toHaveBeenCalledWith([free], { respectEnabledModels: true });
    mocks.catalog.mockResolvedValue({ models: [], accounts: [] });
    const empty = await (await geminiModels(request)).json();
    expect(empty.models.filter(model => /^models\/(cx|codex)\//.test(model.name))).toEqual([]);
  });

  it("tests only models advertised by the selected Codex account", async () => {
    const response = await testConnectionModels(new Request("http://localhost/api/providers/free/test-models", { method: "POST" }),
      { params: Promise.resolve({ id: "free" }) });
    expect(response.status).toBe(200);
    expect(mocks.models).toHaveBeenCalledWith(free);
    expect(mocks.ping).toHaveBeenCalledTimes(1);
    expect(mocks.ping.mock.calls[0].slice(0, 2)).toEqual(["cx/gpt-6-luna", "llm"]);
  });

  it("does not run model tests when discovery failed", async () => {
    mocks.models.mockResolvedValue({ models: [], warning: "unavailable" });
    const response = await testConnectionModels(new Request("http://localhost/api/providers/free/test-models", { method: "POST" }),
      { params: Promise.resolve({ id: "free" }) });
    expect(response.status).toBe(400);
    expect(mocks.ping).not.toHaveBeenCalled();
  });

  it("limits routing settings to Luna models returned by accessible accounts", async () => {
    const data = await (await routingSettings()).json();
    expect(data.models).toEqual([{ value: "gpt-6-luna", label: "gpt-6-luna" }]);
  });
  it("returns only the requested account's live models", async () => {
    const response = await connectionModels(new Request("http://localhost/api/providers/free/models"), { params: Promise.resolve({ id: "free" }) });
    expect((await response.json()).models.map(model => model.id)).toEqual(["gpt-6-luna"]);
    expect(mocks.models).toHaveBeenCalledWith(free);
  });

  it("returns empty with a warning instead of static entries on discovery failure", async () => {
    mocks.models.mockResolvedValue({ models: [], warning: "unavailable" });
    const response = await connectionModels(new Request("http://localhost/api/providers/free/models"), { params: Promise.resolve({ id: "free" }) });
    expect(await response.json()).toMatchObject({ models: [], warning: "unavailable" });
    mocks.catalog.mockResolvedValue({ models: [], accounts: [] });
    expect((await buildModelsList(["llm"])).filter(model => model.owned_by === "cx")).toEqual([]);
    expect((await (await dashboardModels()).json()).models.filter(model => model.provider === "cx")).toEqual([]);
  });

  it("replaces the dashboard's static list and rejects custom or alias bypasses", async () => {
    const data = await (await dashboardModels()).json();
    expect(data.models.filter(model => model.provider === "cx").map(model => model.model)).toEqual(["gpt-6-luna", "gpt-6.1-sol"]);
  });

  it("publishes only models from the caller's accessible account pool", async () => {
    const request = new Request("http://localhost/v1/models");
    const models = (await buildModelsList(["llm"], { request })).filter(model => model.owned_by === "cx");
    expect(models).toEqual([expect.objectContaining({ id: "cx/gpt-6-luna", context_length: 272000, max_completion_tokens: 64000 })]);
    expect(mocks.catalog).toHaveBeenCalledWith([free], { respectEnabledModels: true });
    const owner = new Request("http://localhost/v1/models", { headers: { "x-owner": "yes" } });
    expect((await buildModelsList(["llm"], { request: owner })).filter(model => model.owned_by === "cx").map(model => model.id))
      .toEqual(["cx/gpt-6-luna", "cx/gpt-6.1-sol"]);
  });

  it("honors disabled models and does not publish Codex without accounts", async () => {
    mocks.disabled.mockResolvedValue({ cx: ["gpt-6-luna"] });
    expect((await buildModelsList(["llm"])).filter(model => model.owned_by === "cx")).toEqual([]);
    mocks.connections.mockResolvedValue([]);
    expect((await buildModelsList(["llm"])).filter(model => model.owned_by === "cx")).toEqual([]);
  });

  it.each(["cx/gpt-6.1-terra", "codex/gpt-6.1-terra", "cx/gpt-6.1-terra(high)"])(
    "publishes live limits for the Terra combo seat %s and its cc alias", async seat => {
      mocks.combos.mockResolvedValue([{ name: "gpt-6.1-terra", models: [seat] }]);
      mocks.catalog.mockResolvedValue({ models: [{ ...model("gpt-6.1-terra", ["free"]),
        capabilities: { contextWindow: 500000, maxOutput: 128000 } }], accounts: [] });

      const models = await buildModelsList(["llm"]);
      for (const id of ["gpt-6.1-terra", "cc/gpt-6.1-terra", "cx/gpt-6.1-terra"]) {
        expect(models.find(entry => entry.id === id)).toMatchObject({
          context_length: 500000, max_completion_tokens: 128000,
          capabilities: { contextWindow: 500000, maxOutput: 128000 },
        });
      }
      expect(mocks.catalog).toHaveBeenCalledExactlyOnceWith([free], { respectEnabledModels: true });
    }
  );

  it("keeps the smallest live limit across nested combo seats", async () => {
    mocks.combos.mockResolvedValue([
      { name: "terra", models: ["cx/gpt-6.1-terra"] },
      { name: "mixed", models: ["terra", "cx/gpt-6-luna"] },
    ]);
    mocks.catalog.mockResolvedValue({ models: [
      { ...model("gpt-6.1-terra", ["free"]), capabilities: { contextWindow: 500000, maxOutput: 128000 } },
      model("gpt-6-luna", ["free"]),
    ], accounts: [] });
    const models = await buildModelsList(["llm"]);
    expect(models.find(entry => entry.id === "mixed")).toMatchObject({
      context_length: 272000, max_completion_tokens: 64000,
      capabilities: { contextWindow: 272000 },
    });
  });

  it("keeps static combo limits when the Codex live catalog is unavailable", async () => {
    mocks.combos.mockResolvedValue([{ name: "luna", models: ["cx/gpt-6-luna"] }]);
    mocks.catalog.mockResolvedValue({ models: [], accounts: [] });
    expect((await buildModelsList(["llm"])).find(entry => entry.id === "luna")).toMatchObject({
      context_length: 272000, max_completion_tokens: 128000,
    });
  });

  it("uses live account membership for trials and avoids discovery during polling", async () => {
    const providers = await getTrialProviders([free, pro], { discoverModels: true });
    expect(providers[0]).toMatchObject({ id: "codex", allowCustomModel: false });
    expect(providers[0].models.map(model => [model.id, model.connectionIds])).toEqual([
      ["gpt-6-luna", ["free"]], ["gpt-6.1-sol", ["pro"]],
    ]);
    await getTrialProviders([free, pro]);
    expect(mocks.catalog).toHaveBeenLastCalledWith([free, pro], { forceRefresh: false, cachedOnly: true });
  });
});
