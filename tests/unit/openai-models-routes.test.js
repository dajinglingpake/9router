import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = { connection: vi.fn(), connections: vi.fn(), models: vi.fn(), disabled: vi.fn() };
  state.database = { getProviderConnectionById: state.connection, getProviderConnections: state.connections,
    getModelAliases: async () => ({}), getCustomModels: async () => [], getCombos: async () => [],
    getProviderNodes: async () => [], getSettings: async () => ({}), setModelAlias: vi.fn() };
  return state;
});
vi.mock("@/models", () => mocks.database);
vi.mock("@/lib/localDb", () => mocks.database);
vi.mock("@/lib/openaiModels", () => ({ resolveOpenAIModels: mocks.models }));
vi.mock("@/lib/codexModels", () => ({ resolveCodexCatalog: async () => ({ models: [], accounts: [] }), resolveCodexModels: vi.fn() }));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: mocks.disabled }));
vi.mock("@/sse/services/accountApiKeyAccess.js", () => ({ filterAccountPoolForRequest: async connections => connections }));

import { GET as connectionModels } from "@/app/api/providers/[id]/models/route.js";
import { GET as dashboardModels } from "@/app/api/models/route.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import { getTrialProviders } from "@/lib/codexTrials/catalog";

const account = { id: "openai-account", provider: "openai", authType: "apikey", isActive: true };
const liveModels = [{ id: "gpt-6.1-terra", name: "gpt-6.1-terra", kind: "llm" },
  { id: "gpt-image-next", name: "gpt-image-next", kind: "image" }];
const readConnection = () => connectionModels(new Request("http://localhost/api/providers/openai-account/models"),
  { params: Promise.resolve({ id: account.id }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connections.mockImplementation(async filter => !filter?.provider || filter.provider === "openai" ? [account] : []);
  mocks.connection.mockResolvedValue(account);
  mocks.models.mockResolvedValue({ models: liveModels });
  mocks.disabled.mockResolvedValue({});
});

describe("OpenAI live catalog across routes", () => {
  it("refreshes the account catalog and replaces the dashboard's static entries", async () => {
    expect(await (await readConnection()).json()).toMatchObject({ provider: "openai", models: liveModels });
    expect(mocks.models).toHaveBeenCalledWith(account, { forceRefresh: true });
    const models = (await (await dashboardModels()).json()).models.filter(model => model.provider === "openai");
    expect(models.map(model => model.model)).toEqual(liveModels.map(model => model.id));
  });

  it("publishes model types correctly and honors disabled models", async () => {
    const ids = async kind => (await buildModelsList([kind])).filter(model => model.owned_by === "openai").map(model => model.id);
    expect(await ids("llm")).toEqual(["openai/gpt-6.1-terra"]);
    expect(await ids("image")).toEqual(["openai/gpt-image-next"]);
    mocks.disabled.mockResolvedValue({ openai: ["gpt-6.1-terra"] });
    expect(await ids("llm")).toEqual([]);
  });

  it("offers live chat models in account trials without probing upstream on result polling", async () => {
    const [provider] = await getTrialProviders([account], { discoverModels: true });
    expect(provider.models.map(model => model.id)).toEqual(["gpt-6.1-terra"]);
    await getTrialProviders([account]);
    expect(mocks.models).toHaveBeenCalledTimes(1);
  });

  it("keeps the built-in fallback with a warning when discovery fails", async () => {
    mocks.models.mockResolvedValue({ models: [], warning: "OpenAI catalog unavailable" });
    const data = await (await readConnection()).json();
    expect(data.warning).toBe("OpenAI catalog unavailable");
    expect(data.models.some(model => model.id === "gpt-5.5")).toBe(true);
    const [provider] = await getTrialProviders([account], { discoverModels: true });
    expect(provider.warning).toBe("OpenAI catalog unavailable");
  });
});
