import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

const fixture = vi.hoisted(() => ({ connections: [], keys: [], settings: {}, adapter: null, ping: vi.fn() }));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: async ({ provider } = {}) => fixture.connections.filter(connection => !provider || connection.provider === provider),
  getApiKeys: async () => fixture.keys,
  getSettings: async () => fixture.settings,
  getCombos: async () => [],
  getCustomModels: async () => [{ providerAlias: "kc", id: "openai/custom-model" }, { providerAlias: "gemini", id: "custom-paid" }],
  getModelAliases: async () => ({ kiloManual: "kc/openai/alias-model", geminiManual: "gemini/manual-alias" }),
}));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: async () => fixture.adapter }));
vi.mock("@/app/api/models/test/ping", () => ({ pingModelByKind: fixture.ping }));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/nvidiaModels", () => ({
  resolveNvidiaModels: async () => ({ models: [{ id: "nvidia/catalog-model" }, { id: "deepseek-ai/catalog-model" }] }),
}));
vi.mock("open-sse/utils/proxyFetch.js", async importOriginal => ({
  ...await importOriginal(),
  proxyAwareFetch: async url => {
    if (new URL(url).hostname !== "generativelanguage.googleapis.com") throw Error("Unexpected discovery request");
    return Response.json({ models: ["gemini-catalog-a", "gemini-catalog-b", "gemini-unknown"].map(id => ({
      name: `models/${id}`, supportedGenerationMethods: ["generateContent"],
    })) });
  },
}));
vi.mock("@/lib/geminiPricing", async importOriginal => ({
  ...await importOriginal(),
  getGeminiPricing: async () => new Map([
    ["gemini-catalog-a", { isFree: true, url: "https://aistudio.google.com/docs/pricing#model-a" }],
    ["gemini-catalog-b", { isFree: false, url: "https://aistudio.google.com/docs/pricing#model-b" }],
  ]),
}));
vi.mock("@/lib/kiloModels", () => ({
  resolveKiloCatalog: async connections => ({
    models: connections.length ? [
      { id: "openai/catalog-model", isFree: true },
      { id: "anthropic/catalog-model", isFree: false },
    ] : [],
  }),
}));

import { GET as testResults, PATCH as updatePreferences, POST as runTest } from "@/app/api/models/test/route.js";
import { GET as listModels } from "@/app/api/v1/models/route.js";
import { GET as geminiModels } from "@/app/api/v1beta/models/route.js";
import { GET as providerCatalog } from "@/app/api/providers/gemini/models/route.js";
import { GET as dashboardCatalog } from "@/app/api/models/route.js";
import { buildModelGroups } from "@/shared/utils/selectableModels.js";
import { getModelTestContext } from "@/lib/modelTests";
import { saveModelTest } from "@/lib/db/repos/modelTestsRepo.js";

const local = "http://127.0.0.1:20128";
const geminiAccount = { id: "gemini-account", provider: "gemini", isActive: true, apiKey: "fixture" };
const failed = ["oc/union-alpha", "nvidia/deepseek-ai/catalog-model", "kc/anthropic/catalog-model"];
const passed = ["oc/muse-spark-1.2-contributor-free", "nvidia/nvidia/catalog-model", "kc/openai/catalog-model"];

let db;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE kv(scope TEXT, key TEXT, value TEXT, PRIMARY KEY(scope, key));
    CREATE TABLE apiKeys(id TEXT, key TEXT, isActive INTEGER, accessRestricted INTEGER, allowedIps TEXT)`);
  fixture.adapter = Object.fromEntries(["get", "all", "run"].map(method =>
    [method, (sql, args = []) => db.prepare(sql)[method](...args)]));
  fixture.adapter.transaction = callback => {
    db.exec("BEGIN");
    try {
      const result = callback();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  fixture.connections = [
    { id: "nvidia-shared", provider: "nvidia", isActive: true },
    { id: "kilo-shared", provider: "kilocode", isActive: true },
  ];
  fixture.keys = [{ id: "shared", key: "shared-key", isActive: true }];
  fixture.settings = { requireApiKey: true, hideFailedModels: false };
  fixture.ping.mockReset().mockImplementation(async model =>
    passed.includes(model) ? { ok: true, status: 200, latencyMs: 5 } : { ok: false, status: 429, error: "Quota exceeded" });
});
afterEach(() => db.close());

const request = (path, apiKey) => new Request(local + path, apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : undefined);
const test = model => runTest(new Request(local + "/api/models/test", { method: "POST", body: JSON.stringify({ model }) }));
const update = (provider, changes) => updatePreferences(new Request(local + "/api/models/test", {
  method: "PATCH", body: JSON.stringify({ provider, ...changes }),
}));
const externalIds = async apiKey => (await (await listModels(request("/v1/models", apiKey))).json()).data.map(entry => entry.id);
const geminiIds = async () => (await (await geminiModels(request("/v1beta/models"))).json()).models.map(model => model.name);

describe("model tests and public catalog visibility", () => {
  it("publishes Gemini's live IDs and filters both native names until a successful retest", async () => {
    fixture.connections.push(geminiAccount);
    const model = "gemini-catalog-a";
    const full = `gemini/${model}`;
    expect(await externalIds()).toContain(full);
    expect(await externalIds()).not.toContain("gemini/gemini-4-argon");
    expect(await geminiIds()).toEqual(expect.arrayContaining([`models/${full}`, `models/${model}`]));
    fixture.ping.mockResolvedValueOnce({ ok: false, status: 404, testStatus: "error", source: "upstream", error: "Closed to new users", latencyMs: 5 });
    await test(full);
    expect((await update("gemini", { hideFailedModels: true })).status).toBe(200);
    expect(await externalIds()).not.toContain(full);
    const native = await geminiIds();
    expect(native).not.toContain(`models/${full}`);
    expect(native).not.toContain(`models/${model}`);
    expect(native).toContain("models/gemini-catalog-b");
    fixture.ping.mockResolvedValueOnce({ ok: true, status: 200, latencyMs: 1 });
    await test(full);
    expect(await externalIds()).toContain(full);
    expect(await geminiIds()).toContain(`models/${model}`);
  });

  it("keeps inconclusive Gemini probes and pre-fix failures visible, with reasons after reload", async () => {
    fixture.connections.push(geminiAccount);
    const { scope } = await getModelTestContext("gemini");
    const model = "gemini-catalog-a";
    await saveModelTest(scope, model, { status: "error", testedAt: Date.now() - 10000 });
    await update("gemini", { hideFailedModels: true });
    const get = async () => (await (await testResults(request("/api/models/test?provider=gemini"))).json()).results[model];
    expect((await get()).status).toBe("retry");
    expect(await externalIds()).toContain(`gemini/${model}`);
    const probe = { status: 503, source: "router", testStatus: "retry", ok: false, error: "Not forwarded", latencyMs: 2 };
    fixture.ping.mockResolvedValueOnce(probe);
    expect((await (await test(`gemini/${model}`)).json()).testStatus).toBe("retry");
    expect(await get()).toMatchObject({ status: "retry", error: probe.error, httpStatus: 503, source: "router" });
    expect(await geminiIds()).toContain(`models/${model}`);
  });
  it("persists real probe outcomes and sorts or hides models from all three providers", async () => {
    for (const model of [...failed, ...passed]) {
      expect((await test(model)).status).toBe(200);
    }
    const available = await (await testResults(request("/api/models/test?provider=nvidia"))).json();
    expect(available.canTest).toBe(true);
    expect(available.results["nvidia/catalog-model"].status).toBe("ok");
    expect(available.results["deepseek-ai/catalog-model"].status).toBe("error");

    const untested = "oc/muse-spark-1.3-contributor-free";
    const ids = await externalIds();
    for (const model of passed) expect(ids.indexOf(model)).toBeLessThan(ids.indexOf(untested));
    for (const model of failed) expect(ids.indexOf(model)).toBeGreaterThan(ids.indexOf(untested));

    expect((await update("nvidia", { hideFailedModels: true })).status).toBe(200);
    expect(await externalIds()).toEqual(expect.arrayContaining([failed[0], failed[2]]));
    expect(await externalIds()).not.toContain(failed[1]);
    expect((await update("opencode", { hideFailedModels: true })).status).toBe(200);
    expect((await update("kilocode", { hideFailedModels: true })).status).toBe(200);
    const filtered = await externalIds();
    expect(filtered).toEqual(expect.arrayContaining([...passed, untested]));
    for (const model of failed) expect(filtered).not.toContain(model);
    expect(await geminiIds()).not.toContain("models/oc/union-alpha");
    expect((await update("nvidia", { hideFailedModels: false })).status).toBe(200);
    expect(await externalIds()).toContain(failed[1]);
    expect(await externalIds()).not.toContain(failed[0]);
  });

  it("shows only verified free Kilo models without probes and keeps the two switches independent", async () => {
    const before = await externalIds();
    expect(before).toEqual(expect.arrayContaining([passed[2], failed[2], "kc/openai/custom-model", "kc/openai/alias-model"]));
    expect((await update("nvidia", { freeOnly: true })).status).toBe(400);
    expect((await update("kilocode", { freeOnly: true })).status).toBe(200);
    expect((await update("kilocode", { hideFailedModels: true })).status).toBe(200);
    const { preferences } = await (await testResults(request("/api/models/test?provider=kilocode"))).json();
    expect(preferences).toEqual({ freeOnly: true, hideFailedModels: true });
    expect(fixture.ping).not.toHaveBeenCalled();
    const freeOnly = await externalIds();
    expect(freeOnly.filter(id => id.startsWith("kc/"))).toEqual([passed[2]]);
    expect(freeOnly.filter(id => !id.startsWith("kc/"))).toEqual(before.filter(id => !id.startsWith("kc/")));
    expect((await geminiIds()).filter(id => /^models\/(kc|kilocode)\//.test(id))).toEqual([`models/${passed[2]}`]);

    const response = await update("kilocode", { freeOnly: false });
    expect((await response.json()).preferences).toEqual({ freeOnly: false, hideFailedModels: true });
    expect(await externalIds()).toEqual(before);
  });

  it("filters Gemini by verified pricing in public lists and pickers, independently of probe results", async () => {
    fixture.connections.push(geminiAccount);
    const free = "gemini-catalog-a", paid = "gemini-catalog-b";
    const admin = async (query = "") => (await (await providerCatalog(request("/api/providers/gemini/models" + query))).json());
    const publicGemini = async () => (await externalIds()).filter(id => id.startsWith("gemini/"));
    const before = await publicGemini();
    expect(before).toEqual(expect.arrayContaining([`gemini/${free}`, `gemini/${paid}`, "gemini/gemini-unknown", "gemini/custom-paid", "gemini/manual-alias"]));
    expect((await update("gemini", { freeOnly: "true" })).status).toBe(400);
    expect((await update("gemini", { freeOnly: true })).status).toBe(200);
    const catalog = await admin("?visible=1");
    expect(catalog.freeOnly).toBe(true);
    expect(catalog.models.map(m => m.id)).toEqual([free]);
    expect((await admin()).models.map(m => m.id)).toEqual([free, paid, "gemini-unknown"]);
    expect(await publicGemini()).toEqual([`gemini/${free}`]);
    const native = (await geminiIds()).filter(id => /^models\/(?:gemini\/|gemini-[^/]+$)/.test(id));
    expect(native).toEqual([`models/gemini/${free}`, `models/${free}`]);
    const dashboard = (await (await dashboardCatalog()).json()).models.filter(m => m.provider === "gemini");
    expect(dashboard.map(m => m.model)).toEqual([free]);
    const picker = buildModelGroups({ connections: [geminiAccount], liveModels: { gemini: catalog.models }, geminiFreeOnly: catalog.freeOnly,
      modelAliases: { "manual-alias": "gemini/manual-alias" }, customModels: [{ providerAlias: "gemini", id: "custom-paid" }] });
    expect(picker.gemini.models.map(m => m.id)).toEqual([free]);
    expect(fixture.ping).not.toHaveBeenCalled();
    const { scope } = await getModelTestContext("gemini");
    await saveModelTest(scope, free, { status: "error", testedAt: Date.now(), httpStatus: 404 });
    await update("gemini", { hideFailedModels: true });
    expect(await publicGemini()).toEqual([]);
    expect((await admin("?visible=1")).models).toEqual([]);
    expect((await update("gemini", { hideFailedModels: false })).status).toBe(200);
    const response = await testResults(request("/api/models/test?provider=gemini"));
    expect((await response.json()).preferences).toEqual({ hideFailedModels: false, freeOnly: true });
    await update("gemini", { freeOnly: false });
    expect((await publicGemini()).sort()).toEqual(before.sort());
  });

  it("keeps older results until the next test and isolates them by account pool", async () => {
    fixture.connections.push({ id: "nvidia-private", provider: "nvidia", isActive: true, exclusiveApiKeyIds: ["owner"] });
    db.prepare("INSERT INTO apiKeys VALUES (?, ?, 1, 0, NULL)").run("owner", "owner-key");
    fixture.settings.hideFailedModels = true;

    expect((await test(failed[1])).status).toBe(200);
    expect(await externalIds()).not.toContain(failed[1]);
    expect(await externalIds("owner-key")).toContain(failed[1]);

    const { scope } = await getModelTestContext("nvidia");
    const oldFailure = { status: "error", testedAt: Date.now() - 30 * 24 * 3600000 };
    await saveModelTest(scope, "deepseek-ai/catalog-model", oldFailure);
    expect(await externalIds()).not.toContain(failed[1]);
    expect(await externalIds("owner-key")).toContain(failed[1]);
    const reloaded = await (await testResults(request("/api/models/test?provider=nvidia"))).json();
    expect(reloaded.results["deepseek-ai/catalog-model"]).toEqual(oldFailure);
    expect(reloaded.preferences.hideFailedModels).toBe(true);

    fixture.ping.mockResolvedValueOnce({ ok: true, status: 200, latencyMs: 5 });
    expect((await test(failed[1])).status).toBe(200);
    expect(await externalIds()).toContain(failed[1]);
    const retested = await (await testResults(request("/api/models/test?provider=nvidia"))).json();
    expect(retested.results["deepseek-ai/catalog-model"].status).toBe("ok");
    expect(retested.results["deepseek-ai/catalog-model"].testedAt).toBeGreaterThan(oldFailure.testedAt);
    expect((await update("nvidia", { hideFailedModels: false })).status).toBe(200);
    const overridden = await (await testResults(request("/api/models/test?provider=nvidia"))).json();
    expect(overridden.preferences.hideFailedModels).toBe(false);
  });

  it("does not pollute the catalog when a provider has no testable connection", async () => {
    fixture.connections = fixture.connections.filter(connection => connection.provider !== "kilocode");
    const attempted = await test(passed[2]);
    expect(attempted.status).toBe(409);
    expect(fixture.ping).not.toHaveBeenCalled();
    const status = await (await testResults(request("/api/models/test?provider=kilocode"))).json();
    expect(status).toMatchObject({ canTest: false, results: {} });
  });
});
