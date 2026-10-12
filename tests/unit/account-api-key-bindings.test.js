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
function send(key) {
  const req = request(key.key);
  const body = { model: "cx/gpt-6.1-sol", input: "hello", stream: false };
  const caller = { headers: {}, body, endpoint: "/v1/responses", apiKeyRecordId: key.id };
  return routing.handleSingleModelChat(body, body.model, caller, req, key.key, new Set(), new Set(), Date.now() + 2000);
}

describe("exclusive account isolation", () => {
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
    expect((await sessions.getSessionBinding(sessionKey)).connectionId).toBe(privateB.id);
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
