import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";

const { upstream, catalog } = vi.hoisted(() => ({ upstream: vi.fn(), catalog: vi.fn() }));
vi.mock("open-sse/services/kimchiModels.js", () => ({ resolveKimchiModels: catalog }));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: upstream }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: async (_p, c) => c, updateProviderCredentials: vi.fn() }));
vi.mock("@/lib/providerUsage.js", () => ({ loadConnectionUsage: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/alerts/wecom.js", () => ({ notifyRequestError: vi.fn().mockResolvedValue(undefined) }));

let tempDir, db, local, legacy, sessions, limiter, routing, owner, other, shared, privateA, privateB, listeners;
const originalDataDir = process.env.DATA_DIR;
beforeEach(async () => {
  listeners = Object.fromEntries(["beforeExit", "exit", "SIGINT", "SIGTERM"].map(event => [event, new Set(process.rawListeners(event))]));
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-exclusive-db-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({ requireApiKey: false, localCodexRouting: { accountStrategy: "inherit", apiKeyAffinity: false, quotaFailover: false } });
  owner = await db.createApiKey("owner", "test-machine");
  other = await db.createApiKey("other", "test-machine");
  shared = await db.createProviderConnection({ provider: "codex", authType: "oauth", name: "shared", accessToken: "token", isActive: true });
  privateA = await db.createProviderConnection({ provider: "codex", authType: "oauth", name: "private-a", accessToken: "token", isActive: true, exclusiveApiKeyIds: [owner.id] });
  privateB = await db.createProviderConnection({ provider: "codex", authType: "oauth", name: "private-b", accessToken: "token", isActive: true, exclusiveApiKeyIds: [other.id] });
  local = (await import("@/sse/local/accountSelection.js")).getProviderCredentials;
  legacy = (await import("@/sse/services/auth.js")).getProviderCredentials;
  sessions = await import("@/sse/services/sessionRouting.js");
  limiter = await import("@/sse/services/concurrencyLimiter.js");
  routing = await import("@/sse/local/modelRouting.js");
  limiter.__test__.reset();
  global.__ninerouterAccountSelection.cursors.clear();
  global.__ninerouterAccountSelection.reservations.clear();
  global.__ninerouterAccountRoutingLoads?.clear();
  upstream.mockReset().mockImplementation(async () => ({ success: true, response: Response.json({ ok: true }) }));
  catalog.mockReset().mockResolvedValue({ models: [{ id: "visible-model", name: "Visible model" }] });
});
afterEach(async () => {
  await global._requestErrorWrites?.pending;
  limiter?.__test__.reset();
  global._dbAdapter?.instance?.close?.();
  delete global._dbAdapter;
  for (const [event, original] of Object.entries(listeners)) {
    for (const listener of process.rawListeners(event)) if (!original.has(listener)) process.removeListener(event, listener);
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});
function request(key, kind = "bearer") {
  const headers = {};
  let url = "http://localhost/v1/responses";
  if (key) {
    if (kind === "bearer") headers.Authorization = "Bearer " + key;
    else if (kind === "query") url += "?key=" + encodeURIComponent(key);
    else headers[kind] = key;
  }
  return new Request(url, { method: "POST", headers });
}
async function pick(selector, key, extra = {}, exclude = null) {
  const c = await selector("codex", exclude, "gpt-6.1-sol", { request: request(key), ...extra });
  c?.releaseSelection?.();
  return c;
}
async function update(id, patch) {
  const { PUT } = await import("@/app/api/providers/[id]/route.js");
  return PUT(new Request("http://localhost/api/providers/test", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }), { params: Promise.resolve({ id }) });
}
function send(key, model = "cx/gpt-6.1-sol", sessionId = null) {
  const req = request(key.key);
  if (sessionId) req.headers.set("x-session-id", sessionId);
  const body = { model, input: "hello", stream: false };
  const caller = { headers: Object.fromEntries(req.headers), body, endpoint: "/v1/responses", apiKeyRecordId: key.id };
  return routing.handleSingleModelChat(body, body.model, caller, req, key.key, new Set(), new Set(), Date.now() + 2000);
}

describe("exclusive account isolation", () => {
  it.each(["local", "legacy"])("preserves resolved proxy policy through %s account selection", async kind => {
    const selector = kind === "local" ? local : legacy;
    const pool = await db.createProxyPool({ name: "strict", proxyUrl: "http://127.0.0.1:9", strictProxy: true });
    await db.updateProviderConnection(privateA.id, { providerSpecificData: { proxyPoolId: pool.id } });
    expect((await pick(selector, owner.key)).providerSpecificData).toMatchObject({
      connectionProxyPoolId: pool.id, strictProxy: true,
    });
    await db.updateProxyPool(pool.id, { strictProxy: false });
    expect((await pick(selector, owner.key)).providerSpecificData.strictProxy).toBe(false);
  });
  it.each(["local", "legacy"])("preserves strict proxy policy for no-auth providers through %s", async kind => {
    const selector = kind === "local" ? local : legacy;
    const pool = await db.createProxyPool({ name: "strict-free", proxyUrl: "http://127.0.0.1:9", strictProxy: true });
    await db.updateSettings({ providerStrategies: { opencode: { proxyPoolId: pool.id } } });
    const credentials = await selector("opencode", null, "test-model");
    expect(credentials.providerSpecificData).toMatchObject({ connectionProxyPoolId: pool.id, strictProxy: true });
  });
  it.each(["local", "legacy"])("isolates all callers through %s", async kind => {
    const selector = kind === "local" ? local : legacy;
    const unbound = await db.createApiKey("unbound", "test-machine");
    for (const [key, expected] of [[owner.key, privateA.id], [other.key, privateB.id], [unbound.key, shared.id], [null, shared.id], ["invalid", shared.id]]) {
      expect((await pick(selector, key)).connectionId).toBe(expected);
    }
  });
  it.each(["bearer", "x-api-key", "x-goog-api-key", "query"])("recognizes %s client keys", async kind => {
    const c = await local("codex", null, "gpt-6.1-sol", { request: request(owner.key, kind) });
    expect(c.connectionId).toBe(privateA.id); c.releaseSelection?.();
  });
  it("ignores preferred accounts and forged record IDs", async () => {
    expect((await pick(local, owner.key, { preferredConnectionId: privateB.id, apiKeyRecordId: other.id })).connectionId).toBe(privateA.id);
    expect((await pick(local, null, { preferredConnectionId: privateA.id, apiKeyRecordId: owner.id })).connectionId).toBe(shared.id);
  });
  it("replaces old session bindings when account ownership changes", async () => {
    const sessionKey = sessions.getSessionRoutingKey({ "x-session-id": "stale" }, {}, other.id);
    await sessions.bindSession(sessionKey, "codex", privateA.id);
    expect((await pick(local, other.key, { sessionKey })).connectionId).toBe(privateB.id);
    expect((await sessions.getSessionBinding(sessionKey, "codex")).connectionId).toBe(privateB.id);
  });
  it("overrides stale automatic key bindings", async () => {
    await db.updateSettings({ localCodexRouting: { apiKeyAffinity: true } });
    const affinity = await import("@/sse/local/apiKeyRouting.js");
    const apiKeyRoutingKey = affinity.getApiKeyRoutingKey("codex", owner.id, owner.key);
    await affinity.bindApiKey(apiKeyRoutingKey, "codex", privateB.id, owner.id);
    expect((await pick(local, owner.key, { apiKeyRoutingKey, apiKeyRecordId: owner.id })).connectionId).toBe(privateA.id);
    expect((await affinity.getApiKeyBinding(apiKeyRoutingKey)).connectionId).toBe(privateA.id);
  });
  it.each(["local", "legacy"])("avoids shared fallback after disable, lock or exclusions through %s", async kind => {
    const selector = kind === "local" ? local : legacy;
    expect(await pick(selector, owner.key, {}, new Set([privateA.id]))).toBeNull();
    await db.updateProviderConnection(privateA.id, { isActive: false });
    expect(await pick(selector, owner.key)).toBeNull();
    await db.updateProviderConnection(privateA.id, { isActive: true, modelLock___all: new Date(Date.now() + 60000).toISOString() });
    expect(await pick(selector, owner.key)).toMatchObject({ allRateLimited: true });
  });
  it.each(["local", "legacy"])("keeps multiple bound keys on the same fixed account through %s", async kind => {
    const selector = kind === "local" ? local : legacy;
    const teammate = await db.createApiKey("teammate", "test-machine");
    expect((await update(privateA.id, { exclusiveApiKeyIds: [owner.id, teammate.id] })).status).toBe(200);
    for (const key of [owner.key, teammate.key]) {
      for (let i = 0; i < 3; i++) expect((await pick(selector, key)).connectionId).toBe(privateA.id);
      expect(await pick(selector, key, {}, new Set([privateA.id]))).toBeNull();
    }
    expect((await pick(local, other.key)).connectionId).toBe(privateB.id);
  });
  it("allows configuring multiple keys while disabled without enabling the account", async () => {
    const first = await db.createApiKey("paused-owner", "test-machine");
    const second = await db.createApiKey("paused-teammate", "test-machine");
    await db.updateProviderConnection(shared.id, { isActive: false });
    expect((await update(shared.id, { exclusiveApiKeyIds: [first.id, second.id] })).status).toBe(200);
    expect(await db.getProviderConnectionById(shared.id)).toMatchObject({ isActive: false, exclusiveApiKeyIds: [first.id, second.id] });
    expect(await pick(local, first.key)).toBeNull();
    expect(await pick(local, second.key)).toBeNull();
    await db.updateProviderConnection(shared.id, { isActive: true });
    expect((await pick(local, first.key)).connectionId).toBe(shared.id);
    expect((await pick(local, second.key)).connectionId).toBe(shared.id);
  });
  it("exposes every bound key name in quota tracking without credentials", async () => {
    const teammate = await db.createApiKey("quota-teammate", "test-machine");
    await update(privateA.id, { exclusiveApiKeyIds: [owner.id, teammate.id] });
    const { GET } = await import("@/app/api/providers/client/route.js");
    const response = await GET(new Request("http://localhost/api/providers/client?provider=codex&pageSize=1&page=2"));
    expect(response.status).toBe(200);
    const data = await response.json();
    const c = data.connections[0];
    expect(c.id).toBe(privateA.id);
    expect(c.exclusiveApiKeyIds).toEqual([owner.id, teammate.id]);
    expect(c.exclusiveApiKeyNames).toEqual(["owner", "quota-teammate"]);
    expect(JSON.stringify(data)).not.toContain(owner.key);
    expect(JSON.stringify(data)).not.toContain(teammate.key);
    expect(c.accessToken).toBeUndefined();
    await db.updateApiKey(owner.id, { isActive: false });
    await db.deleteApiKey(teammate.id);
    const refreshed = await (await GET(new Request("http://localhost/api/providers/client?provider=codex&pageSize=1&page=2"))).json();
    expect(refreshed.connections[0].exclusiveApiKeyNames[0]).toBe("owner（已停用）");
    expect(refreshed.connections[0].exclusiveApiKeyNames[1]).toContain("已删除 Key");
  });
  it.each([
    { isActive: true, maxConcurrency: 3, minRequestIntervalMs: 1000, maxRequestIntervalMs: 3000, accountCooldownMinMs: 5000, accountCooldownMaxMs: 15000 },
    { isActive: false, maxConcurrency: 0, minRequestIntervalMs: 0, maxRequestIntervalMs: 0, accountCooldownMinMs: 15000, accountCooldownMaxMs: 30000 },
  ])("preserves saved quota edit settings and bindings when active=$isActive", async settings => {
    const accountExpiresAt = "2027-01-01T00:00:00.000Z";
    expect((await update(privateA.id, { ...settings, accountExpiresAt })).status).toBe(200);
    const { GET } = await import("@/app/api/providers/client/route.js");
    const getAccount = async () => {
      const response = await GET(new Request("http://localhost/api/providers/client?provider=codex"));
      expect(response.status).toBe(200);
      return (await response.json()).connections.find(c => c.id === privateA.id);
    };
    const saved = await getAccount();
    const expected = { ...settings, accountExpiresAt, exclusiveApiKeyIds: [owner.id] };
    expect(saved).toMatchObject(expected);
    for (const field of ["apiKey", "accessToken", "refreshToken", "idToken"]) expect(saved[field]).toBeUndefined();

    // A name-only edit must not reset the settings shown in the quota form.
    const edits = Object.fromEntries(Object.keys(expected).map(field => [field, saved[field]]));
    expect((await update(privateA.id, { ...edits, name: "renamed from quota" })).status).toBe(200);
    expect(await db.getProviderConnectionById(privateA.id)).toMatchObject({ ...expected, name: "renamed from quota" });
    expect(await getAccount()).toMatchObject({ ...expected, name: "renamed from quota" });
  });
  it("rejects assigning one key to multiple accounts in the same provider", async () => {
    expect((await update(shared.id, { exclusiveApiKeyIds: [owner.id] })).status).toBe(409);
    await expect(db.createProviderConnection({ provider: "codex", authType: "oauth", name: "duplicate", exclusiveApiKeyIds: [owner.id] })).rejects.toMatchObject({ code: "EXCLUSIVE_API_KEY_CONFLICT" });
  });
  it("serializes concurrent assignments to prevent duplicate fixed routes", async () => {
    const fresh = await db.createApiKey("concurrent", "test-machine");
    const results = await Promise.all([update(shared.id, { exclusiveApiKeyIds: [fresh.id] }), update(privateA.id, { exclusiveApiKeyIds: [owner.id, fresh.id] })]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  });
  it("retains reservations for disabled, deleted and recreated keys", async () => {
    await db.updateApiKey(owner.id, { isActive: false });
    expect((await pick(local, owner.key)).connectionId).toBe(shared.id);
    await db.deleteApiKey(owner.id);
    const replacementKey = await db.createApiKey("owner", "test-machine");
    expect((await pick(local, replacementKey.key)).connectionId).toBe(shared.id);
    expect((await db.getProviderConnectionById(privateA.id)).exclusiveApiKeyIds).toEqual([owner.id]);
  });
  it("checks the owning key's IP allow list", async () => {
    await db.updateApiKey(owner.id, { allowedIps: ["192.0.2.5"] });
    expect((await pick(local, owner.key)).connectionId).toBe(shared.id);
  });
  it("validates changes and explicitly releases the reservation", async () => {
    for (const value of ["missing", "", 123, {}, null, [123], [""], ["missing"], [owner.key]]) {
      expect((await update(shared.id, { exclusiveApiKeyIds: value })).status).toBe(400);
    }
    await db.updateApiKey(other.id, { isActive: false });
    expect((await update(shared.id, { exclusiveApiKeyIds: [other.id] })).status).toBe(400);
    const fresh = await db.createApiKey("fresh", "test-machine");
    expect((await update(shared.id, { exclusiveApiKeyIds: [fresh.id, fresh.id] })).status).toBe(200);
    expect((await db.getProviderConnectionById(shared.id)).exclusiveApiKeyIds).toEqual([fresh.id]);
    expect((await update(shared.id, { exclusiveApiKeyIds: [] })).status).toBe(200);
    expect((await db.getProviderConnectionById(shared.id)).exclusiveApiKeyIds).toEqual([]);
  });
  it("preserves a missing owner's reservation during unrelated edits and exposes only the name", async () => {
    const { GET } = await import("@/app/api/providers/route.js");
    const data = await (await GET()).json();
    const c = data.connections.find(c => c.id === privateA.id);
    expect(c.exclusiveApiKeyNames).toEqual(["owner"]);
    expect(JSON.stringify(c)).not.toContain(owner.key);
    expect(c.accessToken).toBeUndefined();
    await db.deleteApiKey(owner.id);
    expect((await update(privateA.id, { name: "renamed", exclusiveApiKeyIds: [owner.id] })).status).toBe(200);
    expect((await db.getProviderConnectionById(privateA.id)).exclusiveApiKeyIds).toEqual([owner.id]);
  });
  it("isolates concurrent callers", async () => {
    const selections = await Promise.all(Array.from({ length: 24 }, (_, i) => pick(local, i % 2 ? owner.key : other.key)));
    expect(selections.map(c => c.connectionId)).toEqual(Array.from({ length: 24 }, (_, i) => i % 2 ? privateA.id : privateB.id));
  });
  it.each([true, false])("isolates live model discovery for owner=%s", async isOwner => {
    const unbound = await db.createApiKey("catalog-caller", "test-machine");
    await db.createProviderConnection({ provider: "kimchi", authType: "oauth", name: "shared catalog", accessToken: "shared-catalog-token" });
    await db.createProviderConnection({ provider: "kimchi", authType: "oauth", name: "private catalog", accessToken: "private-catalog-token", exclusiveApiKeyIds: [owner.id] });
    const { GET } = await import("@/app/api/v1/models/route.js");
    expect((await GET(request(isOwner ? owner.key : unbound.key))).status).toBe(200);
    expect(catalog).toHaveBeenCalledTimes(1);
    expect(catalog.mock.calls[0][0].accessToken).toBe(isOwner ? "private-catalog-token" : "shared-catalog-token");
  });
  it("routes chat attempts to the owner's account", async () => {
    expect((await send(owner)).status).toBe(200);
    expect(upstream.mock.calls.map(([args]) => args.credentials.connectionId)).toEqual([privateA.id]);
  });
  it.each(["codex", "openai"])("routes a mixed combo with a pre-upgrade %s session to the available dedicated account", async legacyProvider => {
    const openai = await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "private-openai", apiKey: "test-openai", isActive: true, exclusiveApiKeyIds: [owner.id] });
    await db.updateProviderConnection(privateA.id, { isActive: false });
    await db.createCombo({ name: "mixed", models: ["cx/gpt-6.1-sol", "openai/gpt-6.1-sol"] });
    const sessionKey = sessions.getSessionRoutingKey({ "x-session-id": "old-session" }, {}, owner.id);
    const { setMeta } = await import("@/lib/db/helpers/metaStore.js");
    await setMeta(`chat-session:${sessionKey}`, JSON.stringify({ provider: legacyProvider, connectionId: legacyProvider === "codex" ? privateA.id : openai.id }));

    for (let i = 0; i < 2; i++) {
      const response = await send(owner, "mixed", "old-session");
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(upstream.mock.calls.map(([args]) => args.credentials.connectionId)).toEqual([openai.id, openai.id]);
    expect(await sessions.getSessionBinding(sessionKey, "openai")).toEqual({ provider: "openai", connectionId: openai.id });
    expect(await sessions.getSessionBinding(sessionKey, "codex")).toBeNull();
  });
  it("uses the edited combo in the same session after removing an exclusive account binding", async () => {
    const openai = await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "private-openai", apiKey: "test-openai", isActive: true, exclusiveApiKeyIds: [owner.id] });
    const combo = await db.createCombo({ name: "edited", models: ["openai/gpt-6.1-sol"] });
    const first = await send(owner, combo.name, "unchanged-session");
    expect(first.status).toBe(200);
    await first.text();
    expect((await update(openai.id, { exclusiveApiKeyIds: [] })).status).toBe(200);
    await db.updateCombo(combo.id, { models: ["cx/gpt-6.1-sol"] });
    const second = await send(owner, combo.name, "unchanged-session");
    expect(second.status).toBe(200);
    await second.text();
    expect(upstream.mock.calls.map(([args]) => [args.modelInfo.provider, args.credentials.connectionId])).toEqual([
      ["openai", openai.id], ["codex", privateA.id],
    ]);
  });
  it("falls back across providers after a request rejection without leaving the owner's account pools", async () => {
    const openai = await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "private-openai", apiKey: "test-openai", isActive: true, exclusiveApiKeyIds: [owner.id] });
    await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "shared-openai", apiKey: "shared-openai", isActive: true });
    await db.createProviderConnection({ provider: "anthropic", authType: "apikey", name: "shared-anthropic", apiKey: "shared-anthropic", isActive: true });
    await db.createCombo({ name: "fallback", models: ["anthropic/claude-sonnet-4", "cx/gpt-6.1-sol", "openai/gpt-6.1-sol"] });
    upstream.mockImplementation(async args => args.modelInfo.provider === "codex"
      ? { success: false, status: 400, error: "Request validation failed", response: Response.json({ error: { message: "Request validation failed" } }, { status: 400 }) }
      : { success: true, response: Response.json({ ok: true }) });
    const response = await send(owner, "fallback", "fallback-session");
    expect(response.status).toBe(200);
    await response.text();
    expect(upstream.mock.calls.map(([args]) => args.credentials.connectionId)).toEqual([privateA.id, openai.id]);
  });
  it.each([false, true])("skips shared providers before calling upstream when only one provider is bound (nested: %s)", async nested => {
    await db.updateProviderConnection(privateA.id, { exclusiveApiKeyIds: [] });
    const openai = await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "private-openai", apiKey: "test-openai", isActive: true, exclusiveApiKeyIds: [owner.id] });
    if (nested) await db.createCombo({ name: "inner", models: ["cx/gpt-6.1-sol", "openai/gpt-6.1-sol"] });
    await db.createCombo({ name: "only-bound", models: ["cx/gpt-6.1-sol", nested ? "cc/inner" : "openai/gpt-6.1-sol"] });
    const response = await send(owner, "only-bound", "single-provider");
    expect(response.status).toBe(200);
    await response.text();
    expect(upstream.mock.calls.map(([args]) => args.credentials.connectionId)).toEqual([openai.id]);
    const sessionKey = sessions.getSessionRoutingKey({ "x-session-id": "single-provider" }, {}, owner.id);
    expect(await sessions.getSessionBinding(sessionKey, "codex")).toBeNull();
  });
  it("rejects combos without a bound provider instead of using a shared provider", async () => {
    await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "shared-openai", apiKey: "test-openai", isActive: true });
    await db.createCombo({ name: "unbound", models: ["openai/gpt-6.1-sol"] });
    const response = await send(owner, "unbound", "restricted-session");
    expect(response.status).toBe(503);
    expect((await response.json()).error.message).toContain("没有当前 API Key 已绑定提供商的模型");
    expect(upstream).not.toHaveBeenCalled();
  });
  it("keeps disabled private providers reserved without falling back to another shared provider", async () => {
    await db.updateProviderConnection(privateA.id, { isActive: false });
    await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "shared-openai", apiKey: "test-openai", isActive: true });
    await db.createCombo({ name: "disabled-owner", models: ["openai/gpt-6.1-sol", "cx/gpt-6.1-sol"] });
    expect((await send(owner, "disabled-owner", "disabled-session")).status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("uses shared providers in the next request after all dedicated bindings are removed", async () => {
    const openai = await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "shared-openai", apiKey: "test-openai", isActive: true });
    await db.createCombo({ name: "released", models: ["openai/gpt-6.1-sol", "cx/gpt-6.1-sol"] });
    const first = await send(owner, "released", "released-session");
    expect(first.status).toBe(200);
    await first.text();
    expect((await update(privateA.id, { exclusiveApiKeyIds: [] })).status).toBe(200);
    const second = await send(owner, "released", "released-session");
    expect(second.status).toBe(200);
    await second.text();
    expect(upstream.mock.calls.map(([args]) => args.credentials.connectionId)).toEqual([privateA.id, openai.id]);
  });
  it("does not retry overloaded private accounts against the shared pool", async () => {
    upstream.mockImplementation(async () => ({ success: false, status: 503, error: "overloaded", response: Response.json({ error: "overloaded" }, { status: 503 }) }));
    expect((await send(owner)).status).toBe(503);
    expect(upstream.mock.calls.map(([args]) => args.credentials.connectionId)).toEqual([privateA.id]);
  });
  it("rechecks account ownership after waiting for a slot", async () => {
    await db.updateProviderConnection(shared.id, { maxConcurrency: 1 });
    const loads = await import("@/sse/local/accountLoad.js");
    const permit = await loads.acquireAccountSlot({ scope: "account", id: shared.id, limit: 1, deadline: Date.now() + 2000 });
    const unbound = await db.createApiKey("waiting", "test-machine");
    const responsePromise = send(unbound);
    await vi.waitFor(() => expect(limiter.__test__.snapshot("account", shared.id).queued).toBe(1));
    const newOwner = await db.createApiKey("new-owner", "test-machine");
    await db.updateProviderConnection(shared.id, { exclusiveApiKeyIds: [newOwner.id] });
    permit.release();
    expect((await responsePromise).status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("persists reservations across database reopen", async () => {
    global._dbAdapter.instance.close(); delete global._dbAdapter;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    local = (await import("@/sse/local/accountSelection.js")).getProviderCredentials;
    expect((await db.getProviderConnectionById(privateA.id)).exclusiveApiKeyIds).toEqual([owner.id]);
    expect((await pick(local, owner.key)).connectionId).toBe(privateA.id);
  });
});
