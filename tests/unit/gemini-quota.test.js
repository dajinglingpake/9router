import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocalGeminiUsage, parseGeminiQuota } from "@/lib/geminiUsage";
import { getProviderConnectionById, setGeminiModelQuota } from "@/lib/db/repos/connectionsRepo";
import { recordGeminiQuotaResponse } from "@/lib/db/repos/geminiQuotaRepo";

const state = vi.hoisted(() => ({ adapter: null }));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: async () => state.adapter }));
let db;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE providerConnections (id TEXT PRIMARY KEY, provider TEXT, authType TEXT, name TEXT, email TEXT,
    priority INTEGER, isActive INTEGER, data TEXT, createdAt TEXT, updatedAt TEXT);
    CREATE TABLE usageHistory (provider TEXT, connectionId TEXT, timestamp TEXT, model TEXT, tokens TEXT, meta TEXT);
    CREATE TABLE requestErrors (provider TEXT, connectionId TEXT, model TEXT, timestamp INTEGER, data TEXT);
    CREATE TABLE kv (scope TEXT, key TEXT, value TEXT, PRIMARY KEY(scope, key))`);
  const initial = { apiKey: "fixture", providerSpecificData: { proxyPoolId: "original" } };
  db.prepare("INSERT INTO providerConnections VALUES ('account', 'gemini', 'apikey', 'demo', NULL, 1, 1, ?, '', '')").run(JSON.stringify(initial));
  state.adapter = Object.fromEntries(["get", "all", "run"].map(op => [op, (sql, binds) => db.prepare(sql)[op](...binds)]));
  state.adapter.transaction = f => f();
});
afterEach(() => db.close());

describe("Gemini quota tracker", () => {
  it("validates manual limits and updates one model without overwriting the connection or other limits", async () => {
    expect(parseGeminiQuota({ model: "gemini/gemini-a", limits: { rpm: 0 } })).toEqual({ model: "gemini-a", limits: { rpm: 0 } });
    for (const limits of [{ rpm: -1 }, { rpd: 1.5 }, { tpm: "x" }, { price: 10 }]) {
      expect(parseGeminiQuota({ model: "a", limits })).toBeNull();
    }
    await setGeminiModelQuota("account", "a", { rpm: 0, rpd: 20 });
    await setGeminiModelQuota("account", "b", { tpm: 300 });
    expect((await getProviderConnectionById("account")).providerSpecificData.geminiQuotaLimits.a.rpm).toBe(0);
    await setGeminiModelQuota("account", "a", {});
    expect(await getProviderConnectionById("account")).toMatchObject({
      apiKey: "fixture", providerSpecificData: { proxyPoolId: "original", geminiQuotaLimits: { b: { tpm: 300 } } },
    });
    expect((await getProviderConnectionById("account")).providerSpecificData.geminiQuotaLimits.a).toBeUndefined();
  });

  it("separates rolling-minute and Pacific-day usage and counts only new requests on top of a dated Google reading", async () => {
    const now = new Date("2026-11-01T07:00:30Z"); // Midnight PDT, before fall-back.
    const add = (id, time, tokens) => db.prepare("INSERT INTO usageHistory VALUES ('gemini', ?, ?, 'm', ?, NULL)").run(id, new Date(time).toISOString(), JSON.stringify(tokens));
    add("account", "2026-11-01T06:59:50Z", { prompt_tokens: 7 });
    add("account", "2026-11-01T07:00:04Z", { prompt_tokens: 2, completion_tokens: 3 });
    add("account", "2026-11-01T07:00:25Z", { input_tokens: 4, output_tokens: 5 });
    add("another", "2026-11-01T07:00:20Z", { input_tokens: 100 });
    const connection = { id: "account", providerSpecificData: {
      geminiQuotaLimits: { m: { rpd: 20 }, unused: { rpm: 0 } },
      geminiQuotaSnapshot: { projectId: "example-project", observedAt: "2026-11-01T07:00:10.000Z", models: { m: { rpd: { limit: 20, used: 8 } } } },
    } };
    const { geminiUsage, detailUrl } = await getLocalGeminiUsage(connection, now);
    expect(detailUrl).toContain("project=example-project");
    expect(geminiUsage.dayStart).toBe("2026-11-01T07:00:00.000Z");
    expect(geminiUsage.models.find(row => row.model === "m")).toMatchObject({ rpm: 3, tpm: 13, rpd: 2, estimatedRpd: 9, inputTokens: 6, outputTokens: 8 });
    expect(geminiUsage.models.find(row => row.model === "unused")).toMatchObject({ rpd: 0, limits: { rpm: 0 } });
    const next = await getLocalGeminiUsage(connection, new Date("2026-11-02T08:00:05Z"));
    expect(next.geminiUsage.dayStart).toBe("2026-11-02T08:00:00.000Z");
    expect(next.geminiUsage.useDailySnapshot).toBe(false);
    expect(next.geminiUsage.models.find(row => row.model === "m")).toMatchObject({ estimatedRpd: 0, limits: { rpd: 20 } });
  });

  it("supplies the confirmed defaults and lets a connection override or restore a single metric", async () => {
    const model = "gemini-4-hydrogen";
    const now = new Date("2026-11-25T09:12:00Z");
    const read = async (id = model) => (await getLocalGeminiUsage(await getProviderConnectionById("account"), now)).geminiUsage.models.find(row => row.model === id);
    const fresh = await getLocalGeminiUsage({ id: "another" }, now);
    expect(fresh.geminiUsage.models).toHaveLength(13);
    expect(await read()).toMatchObject({ rpd: 0, limits: { rpm: 5, tpm: 250000, rpd: 20 } });
    expect((await read("gemini-3.1-flash-lite")).limits).toEqual({ rpm: 15, tpm: 250000, rpd: 500 });
    expect((await read("gemini-2.5-flash-lite")).limits).toEqual({ rpm: 10, tpm: 250000, rpd: 20 });
    expect((await read("gemini-4-neon")).limits).toEqual({ rpm: 0, tpm: 0, rpd: 0 });
    expect(await read("gemini-3.1-flash-lite-preview")).toBeUndefined();
    for (const limit of [undefined, -1, "", 1.1, 2 ** 53]) expect(parseGeminiQuota({ model, metric: "rpd", limit })).toBeNull();
    expect(parseGeminiQuota({ model, metric: "unknown", limit: null })).toBeNull();
    for (const [metric, limit] of [["rpm", 2], ["rpd", 0], ["rpd", null]]) {
      const patch = parseGeminiQuota({ model, metric, limit });
      expect(patch).toEqual({ model, limits: { [metric]: limit }, partial: true });
      await setGeminiModelQuota("account", model, patch.limits, patch.partial);
      const row = await read();
      expect(row.limits).toEqual({ rpm: 2, tpm: 250000, rpd: limit === 0 ? 0 : 20 });
      expect(row.defaultLimits.rpd).toBe(20);
    }
    expect((await getProviderConnectionById("account")).providerSpecificData.geminiQuotaLimits[model]).toEqual({ rpm: 2 });
    await setGeminiModelQuota("account", model, { rpm: 5 }, true);
    expect((await getProviderConnectionById("account")).providerSpecificData.geminiQuotaLimits[model]).toBeUndefined();
  });

  it("recovers only confirmed upstream failures, including recovered attempts, independently of diagnostic retention", async () => {
    const model = "gemini-4-hydrogen", account = { id: "account" };
    const error = (at, data, id = account.id, target = model) => db.prepare("INSERT INTO requestErrors VALUES ('gemini', ?, ?, ?, ?)")
      .run(id, target, Date.parse(at), JSON.stringify(data));
    const busy = { source: "upstream", upstreamStatus: 503, statusCode: 503, requestId: "r1", attempt: 1 };
    const time = "2026-11-25T09:07:21.065Z";
    error("2026-11-25T08:52:51.872Z", busy);
    error(time, { ...busy, requestId: "r2", recovered: true });
    error(time, { ...busy, source: "router" });
    error(time, { source: "upstream", statusCode: 502, message: "fetch failed" });
    error(time, busy, "another");
    error(time, { source: "upstream", statusCode: 404, message: '{"error":{"code":404}}' }, account.id, "legacy");
    db.prepare("INSERT INTO usageHistory VALUES ('gemini', ?, ?, ?, ?, NULL)").run(account.id, "2026-11-25T09:11:23.570Z", model, '{"input_tokens":32,"output_tokens":13}');
    const now = new Date("2026-11-25T09:11:40Z");
    const read = async () => (await getLocalGeminiUsage(account, now)).geminiUsage.models;
    expect((await read()).find(r => r.model === model)).toMatchObject({ rpd: 3, rpm: 1, tpm: 32, estimatedRpd: 3, inputTokens: 32, outputTokens: 13 });
    expect((await read()).find(r => r.model === "legacy")).toMatchObject({ rpd: 1, limits: {} });
    db.exec("DELETE FROM requestErrors");
    expect((await read()).find(r => r.model === model).rpd).toBe(3);
  });

  it("counts each HTTP response once across midnight, even for concurrent retries, without duplicating token history", async () => {
    const account = { id: "account" }, model = "gemini-4-hydrogen";
    const before = new Date("2026-03-09T06:59:55.000Z");
    const midnight = new Date("2026-03-09T07:00:00.000Z");
    await recordGeminiQuotaResponse(account.id, model, before);
    await Promise.all([recordGeminiQuotaResponse(account.id, model, midnight), recordGeminiQuotaResponse(account.id, model, midnight)]);
    db.prepare("INSERT INTO usageHistory VALUES ('gemini', ?, ?, ?, ?, ?)").run(account.id, midnight.toISOString(), model, '{"prompt_tokens":7,"completion_tokens":3}', '{"geminiQuotaRecorded":true}');
    const read = async now => (await getLocalGeminiUsage(account, now)).geminiUsage.models.find(row => row.model === model);
    expect(await read(before)).toMatchObject({ rpm: 1, rpd: 1, tpm: 0 });
    expect(await read(midnight)).toMatchObject({ rpm: 3, rpd: 2, tpm: 7, inputTokens: 7, outputTokens: 3 });
    expect(await read(new Date(midnight.getTime() + 60000))).toMatchObject({ rpm: 0, rpd: 2, tpm: 0, limits: { rpd: 20 } });
    expect(await read(new Date(midnight.getTime() + 86400000))).toMatchObject({ rpm: 0, estimatedRpd: 0, limits: { rpd: 20 } });
  });
});
