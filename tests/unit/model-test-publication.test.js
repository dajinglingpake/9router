import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

const fixture = vi.hoisted(() => ({ connections: [], keys: [], settings: {}, adapter: null, ping: vi.fn() }));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: async ({ provider } = {}) => fixture.connections.filter(connection => !provider || connection.provider === provider),
  getApiKeys: async () => fixture.keys,
  getSettings: async () => fixture.settings,
  getCombos: async () => [],
  getCustomModels: async () => [{ providerAlias: "kc", id: "openai/custom-model" }],
  getModelAliases: async () => ({ kiloManual: "kc/openai/alias-model" }),
}));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: async () => fixture.adapter }));
vi.mock("@/app/api/models/test/ping", () => ({ pingModelByKind: fixture.ping }));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/nvidiaModels", () => ({
  resolveNvidiaModels: async () => ({ models: [{ id: "nvidia/catalog-model" }, { id: "deepseek-ai/catalog-model" }] }),
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
import { getModelTestContext } from "@/lib/modelTests";
import { saveModelTest } from "@/lib/db/repos/modelTestsRepo.js";

const local = "http://127.0.0.1:20128";
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
