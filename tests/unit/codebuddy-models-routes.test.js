import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  getProviderConnections: vi.fn(),
  getModelAliases: vi.fn(async () => ({})),
  getCustomModels: vi.fn(async () => []),
  getCombos: vi.fn(async () => []),
  setModelAlias: vi.fn(),
}));
vi.mock("@/models", () => db);
vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/codebuddyModels", () => ({ resolveCodebuddyModels: vi.fn() }));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: vi.fn(async () => ({})) }));

import { resolveCodebuddyModels } from "@/lib/codebuddyModels";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { GET as connectionModels } from "@/app/api/providers/[id]/models/route.js";
import { GET as dashboardModels } from "@/app/api/models/route.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";

const conn = { id: "cb-connection", provider: "codebuddy-cn", authType: "oauth", isActive: true };
const live = {
  models: [{
    id: "space-bunny", name: "Space-Bunny",
    capabilities: { vision: true, reasoning: true, tools: true, contextWindow: 1000000, maxOutput: 128000 },
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  }],
};
const getConnectionModels = () => connectionModels(
  new Request("http://localhost/api/providers/cb-connection/models"),
  { params: Promise.resolve({ id: "cb-connection" }) },
);

beforeEach(() => {
  vi.clearAllMocks();
  db.getProviderConnectionById.mockResolvedValue(conn);
  db.getProviderConnections.mockResolvedValue([conn]);
  db.getCustomModels.mockResolvedValue([]);
  getDisabledModels.mockResolvedValue({});
  resolveCodebuddyModels.mockResolvedValue(live);
});

describe("CodeBuddy live catalogs across model endpoints", () => {
  it("refreshes the provider page's catalog and preserves live capabilities", async () => {
    const res = await getConnectionModels();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ provider: "codebuddy-cn", models: live.models });
    expect(resolveCodebuddyModels).toHaveBeenCalledWith(conn, { forceRefresh: true });
  });

  it("uses the static catalog with a warning if discovery fails", async () => {
    resolveCodebuddyModels.mockResolvedValue({ models: [], warning: "catalog unavailable" });
    const data = await (await getConnectionModels()).json();
    expect(data.models.some((m) => m.id === "glm-5.2")).toBe(true);
    expect(data.warning).toBe("catalog unavailable");
    const dashboard = await (await dashboardModels()).json();
    expect(dashboard.models.some((m) => m.routedModel === "cbcn/glm-5.2")).toBe(true);
    expect((await buildModelsList(["llm"])).some((m) => m.id === "cbcn/glm-5.2")).toBe(true);
  });

  it("replaces the dashboard's static CodeBuddy list and deduplicates custom shadows", async () => {
    db.getCustomModels.mockResolvedValue([{ providerAlias: "cbcn", id: "space-bunny", caps: { contextWindow: 1 } }]);
    const data = await (await dashboardModels()).json();
    const models = data.models.filter((m) => m.routedModel.startsWith("cbcn/"));
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      routedModel: "cbcn/space-bunny", name: "Space-Bunny",
      caps: { contextWindow: 1000000, maxOutput: 128000 },
    });
    expect(db.getProviderConnections).toHaveBeenCalledWith({ provider: "codebuddy-cn", isActive: true });
  });

  it("publishes live client IDs with real token limits and honors disabled models", async () => {
    let models = (await buildModelsList(["llm"])).filter((m) => m.owned_by === "cbcn");
    expect(models).toEqual([expect.objectContaining({
      id: "cbcn/space-bunny", context_length: 1000000, max_completion_tokens: 128000,
    })]);
    getDisabledModels.mockResolvedValue({ cbcn: ["space-bunny"] });
    models = (await buildModelsList(["llm"])).filter((m) => m.owned_by === "cbcn");
    expect(models).toEqual([]);
    const data = await (await dashboardModels()).json();
    expect(data.models.some((m) => m.routedModel === "cbcn/space-bunny")).toBe(false);
  });

  it("keeps the explicit client model allowlist", async () => {
    db.getProviderConnections.mockResolvedValue([{ ...conn, providerSpecificData: { enabledModels: ["glm-5.2"] } }]);
    const models = (await buildModelsList(["llm"])).filter((m) => m.owned_by === "cbcn");
    expect(models.map((m) => m.id)).toEqual(["cbcn/glm-5.2"]);
    expect(resolveCodebuddyModels).not.toHaveBeenCalled();
  });
});
