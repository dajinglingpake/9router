import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KILO_MODELS_CONFIG } from "open-sse/providers/registry/kilocode.js";
import { parseModel } from "open-sse/services/model.js";
import { buildModelGroups } from "@/shared/utils/selectableModels";

const accountList = vi.hoisted(() => vi.fn());
vi.mock("@/models", () => ({ getProviderConnections: accountList }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => ({}) }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (url, options) => fetch(url, options) }));

const paid = { id: "vendor/short-context", name: "Short Context", isFree: false, context_length: 8192 };
const free = { id: "kilo-auto/free", name: "Auto Free", isFree: true, context_length: 32000 };
const request = (query = "") => new Request(`http://localhost/api/providers/kilo/models${query}`);

beforeEach(() => {
  vi.resetModules();
  accountList.mockReset().mockResolvedValue([]);
  vi.stubGlobal("__ninerouterKiloModels", new Map());
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Kilo Code model catalog", () => {
  it("loads all model IDs once and preserves the free-only API contract", async () => {
    const { GET } = await import("@/app/api/providers/kilo/models/route.js");
    const { GET: getFree } = await import("@/app/api/providers/kilo/free-models/route.js");
    fetch.mockResolvedValueOnce(Response.json({ data: [free, paid, null, { id: " " }, paid] }));

    const [catalog, freeOnly] = await Promise.all([GET(request()), getFree()]);
    expect((await catalog.json()).models.map(m => m.id)).toEqual([free.id, paid.id]);
    expect((await freeOnly.json()).models).toEqual([
      { id: free.id, name: free.name, isFree: true, context_length: 32000 },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(KILO_MODELS_CONFIG.url, expect.objectContaining({
      headers: { Accept: "application/json" }, cache: "no-store",
    }));
  });

  it("replaces retired IDs on refresh and keeps the last good list if refresh fails", async () => {
    const { GET } = await import("@/app/api/providers/kilo/models/route.js");
    fetch.mockResolvedValueOnce(Response.json({ data: [free] }))
      .mockResolvedValueOnce(Response.json({ data: [paid] }))
      .mockResolvedValueOnce(Response.json({ data: [] }));
    await GET(request());
    expect((await (await GET(request())).json()).cached).toBe(true);
    const fresh = await (await GET(request("?refresh=1"))).json();
    expect(fresh.cached).toBe(false);
    expect(fresh.models.map(m => m.id)).toEqual([paid.id]);

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + KILO_MODELS_CONFIG.cacheTtlMs + 1);
    const stale = await (await GET(request())).json();
    expect(stale).toMatchObject({ models: fresh.models, cached: true, warning: expect.any(String) });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("reports a cold upstream failure and retries on the next visit", async () => {
    const { GET } = await import("@/app/api/providers/kilo/models/route.js");
    fetch.mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ data: [paid] }));
    const failed = await GET(request());
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ models: [], error: expect.stringContaining("503") });
    expect((await (await GET(request())).json()).models).toHaveLength(1);
  });

  it("keeps personal and organization catalogs separate and respects each connection's model selection", async () => {
    const { resolveKiloCatalog } = await import("@/lib/kiloModels");
    const { GET } = await import("@/app/api/providers/kilo/models/route.js");
    const personal = { id: "personal", accessToken: "personal-token", providerSpecificData: { enabledModels: [`kc/${paid.id}`] } };
    const team = { id: "team", accessToken: "team-token", providerSpecificData: { orgId: "org-1" } };
    const teamModel = { id: "vendor/team-model" };
    accountList.mockResolvedValue([personal, team]);
    fetch.mockImplementation(async (url, { headers }) => {
      if (url === "https://api.kilo.ai/api/organizations/org-1/models") {
        expect(headers).toMatchObject({ Authorization: "Bearer team-token", "X-KiloCode-OrganizationId": "org-1" });
        return Response.json({ data: [teamModel] });
      }
      expect(url).toBe("https://api.kilo.ai/api/gateway/models");
      expect(headers.Authorization).toBe("Bearer personal-token");
      return Response.json({ data: [free, paid] });
    });
    const all = await (await GET(request())).json();
    expect(all.models.map(m => m.id)).toEqual([free.id, paid.id, teamModel.id]);
    const selected = await resolveKiloCatalog([personal, team], { respectEnabledModels: true });
    expect(selected.models.map(m => m.id)).toEqual([paid.id, teamModel.id]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("honors an empty organization allowlist and never serves another scope on failure", async () => {
    const { resolveKiloModels } = await import("@/lib/kiloModels");
    const team = { id: "conn", accessToken: "token", providerSpecificData: { orgId: "a" } };
    fetch.mockResolvedValueOnce(Response.json({ data: [paid] }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ data: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect((await resolveKiloModels(team)).models).toHaveLength(1);
    expect(await resolveKiloModels(team, { forceRefresh: true })).toMatchObject({ models: [], error: expect.stringContaining("403") });
    expect(await resolveKiloModels(team)).toMatchObject({ models: [], cached: false });
    expect(await resolveKiloModels({ ...team, providerSpecificData: { orgId: "b" } }))
      .toMatchObject({ models: [], error: expect.stringContaining("503") });
    expect(buildModelGroups({ connections: [{ ...team, provider: "kilocode" }], liveModels: { kilocode: [] } }).kilocode).toBeUndefined();
  });

  it("keeps nested Kilo IDs routable and applies the picker's custom and disabled models", () => {
    const { kilocode } = buildModelGroups({
      connections: [{ id: "fixture", provider: "kilocode", isActive: true }],
      liveModels: { kilocode: [free, paid, paid] },
      customModels: [{ providerAlias: "kc", id: "user/custom" }],
      disabledModels: { kc: [free.id] },
    });
    expect(kilocode.models.map(m => m.value)).toEqual(["kc/user/custom", `kc/${paid.id}`]);
    expect(parseModel(kilocode.models[1].value)).toMatchObject({ provider: "kilocode", model: paid.id });
  });
});
