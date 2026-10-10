import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { upstream, refresh } = vi.hoisted(() => ({ upstream: vi.fn(), refresh: vi.fn() }));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: upstream }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: refresh,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("@/lib/providerUsage.js", () => ({ loadConnectionUsage: vi.fn().mockResolvedValue(null) }));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), maskKey: () => "test-key",
}));

const originalDataDir = process.env.DATA_DIR;
const MODEL = "gpt-6.1-sol";
const OVERLOAD = "Our servers are currently overloaded. Please try again later.";
let tempDir, db, routing, sessions, selection, limiter, loads, listeners, heldPermits;

beforeEach(async () => {
  heldPermits = [];
  listeners = Object.fromEntries(["beforeExit", "exit", "SIGINT", "SIGTERM"].map(event => [event, new Set(process.rawListeners(event))]));
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-session-failover-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  upstream.mockReset();
  refresh.mockReset().mockImplementation(async (_provider, credentials) => credentials);
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({ localCodexRouting: { accountStrategy: "least-loaded", quotaFailover: false } });
  routing = await import("@/sse/local/modelRouting.js");
  sessions = await import("@/sse/services/sessionRouting.js");
  selection = await import("@/sse/local/accountSelection.js");
  limiter = await import("@/sse/services/concurrencyLimiter.js");
  loads = await import("@/sse/local/accountLoad.js");
  limiter.__test__.reset();
  global.__ninerouterAccountSelection.cursors.clear();
  global.__ninerouterAccountSelection.reservations.clear();
  global.__ninerouterAccountRoutingLoads.clear();
});

afterEach(async () => {
  await global._requestErrorWrites?.pending;
  heldPermits.forEach(permit => permit.release());
  limiter?.__test__.reset();
  global._dbAdapter?.instance?.close?.();
  delete global._dbAdapter;
  for (const [event, original] of Object.entries(listeners)) {
    for (const listener of process.rawListeners(event)) {
      if (!original.has(listener)) process.removeListener(event, listener);
    }
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function account(name, maxConcurrency = 1) {
  const connection = await db.createProviderConnection({ provider: "codex", authType: "oauth", name, accessToken: "test-token", isActive: true });
  return db.updateProviderConnection(connection.id, { maxConcurrency });
}

async function occupy(connection, count = 1) {
  for (let i = 0; i < count; i++) {
    heldPermits.push(await loads.acquireAccountSlot({ scope: "account", id: connection.id, limit: connection.maxConcurrency, deadline: Date.now() + 1500 }));
  }
}

function sessionKey(sessionId = "failover-session") {
  return sessions.getSessionRoutingKey({ "x-session-id": sessionId }, {}, "test-caller");
}

function send(sessionId = "failover-session") {
  const body = { model: `cx/${MODEL}`, input: "hello", stream: false };
  const request = new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "Content-Type": "application/json", "x-session-id": sessionId }, body: JSON.stringify(body),
  });
  const caller = { headers: Object.fromEntries(request.headers), body, endpoint: "/v1/responses", apiKeyRecordId: "test-caller" };
  return routing.handleSingleModelChat(body, body.model, caller, request, null, new Set(), new Set(), Date.now() + 1500);
}

function overloaded() {
  return { success: false, status: 503, error: OVERLOAD, response: Response.json({ error: OVERLOAD }, { status: 503 }) };
}

function success() {
  return { success: true, response: Response.json({ ok: true }) };
}

describe("session overload failover", () => {
  it.each(["inherit", "quota-priority", "fill-first", "least-loaded", "round-robin"])("chooses idle recovered accounts before busy healthy accounts with %s", async accountStrategy => {
    const busy = await account("busy-high-quota", 0), idle = await account("idle-overload-history", 0);
    await db.updateSettings({ localCodexRouting: { accountStrategy, quotaFailover: false } });
    await db.updateProviderConnection(idle.id, { errorCode: 503, lastErrorAt: new Date().toISOString() });
    await occupy(busy, 4);
    const { loadConnectionUsage } = await import("@/lib/providerUsage.js");
    loadConnectionUsage.mockImplementation(async connection => ({ quotas: { session: { used: connection.id === busy.id ? 0 : 80, total: 100 } } }));

    for (const bound of [false, true]) {
      const key = sessionKey(`idle-first-${bound}`);
      if (bound) await sessions.bindSession(key, "codex", busy.id);
      const selected = await selection.getProviderCredentials("codex", null, MODEL, { sessionKey: key });
      expect(selected.connectionId).toBe(idle.id);
      expect((await sessions.getSessionBinding(key)).connectionId).toBe(idle.id);
      selected.releaseSelection?.();
    }
  });

  it("spreads ten simultaneous selections across ten unlimited accounts even when eight have overload history", async () => {
    await db.updateSettings({ localCodexRouting: { accountStrategy: "quota-priority", quotaFailover: true } });
    const accounts = [];
    for (let i = 0; i < 10; i++) {
      const connection = await account(`account-${i}`, 0);
      accounts.push(connection);
      if (i < 8) await db.updateProviderConnection(connection.id, { errorCode: 503, lastErrorAt: new Date().toISOString() });
    }
    const selected = await Promise.all(accounts.map((_, i) => selection.getProviderCredentials("codex", null, MODEL, { sessionKey: sessionKey(`parallel-${i}`) })));
    expect(new Set(selected.map(item => item.connectionId))).toEqual(new Set(accounts.map(item => item.id)));
    for (const credentials of selected) {
      heldPermits.push(await loads.acquireAccountSlot({ scope: "account", id: credentials.connectionId, limit: 0 }, credentials.releaseSelection));
    }
    expect(accounts.map(connection => loads.getAccountActiveCount(connection.id))).toEqual(Array(10).fill(1));
    expect(global.__ninerouterAccountSelection.reservations.size).toBe(0);
  });

  it("moves a busy binding to the least busy account before considering overload history or quota", async () => {
    const busy = await account("busy", 0), lessBusy = await account("less-busy", 0);
    await db.updateSettings({ localCodexRouting: { accountStrategy: "quota-priority", quotaFailover: false } });
    await db.updateProviderConnection(lessBusy.id, { errorCode: 503, lastErrorAt: new Date().toISOString() });
    await occupy(busy, 4);
    await occupy(lessBusy, 1);
    await sessions.bindSession(sessionKey(), "codex", busy.id);
    const selected = await selection.getProviderCredentials("codex", null, MODEL, { sessionKey: sessionKey() });
    expect(selected.connectionId).toBe(lessBusy.id);
    expect((await sessions.getSessionBinding(sessionKey())).connectionId).toBe(lessBusy.id);
    selected.releaseSelection?.();
  });

  it("keeps an equally loaded healthy binding instead of moving it just for a higher quota", async () => {
    const a = await account("a", 0), b = await account("b", 0);
    await db.updateSettings({ localCodexRouting: { accountStrategy: "quota-priority", quotaFailover: false } });
    await occupy(a);
    await occupy(b);
    await sessions.bindSession(sessionKey(), "codex", a.id);
    const { loadConnectionUsage } = await import("@/lib/providerUsage.js");
    loadConnectionUsage.mockImplementation(async connection => ({ quotas: { session: { used: connection.id === a.id ? 80 : 0, total: 100 } } }));
    const selected = await selection.getProviderCredentials("codex", null, MODEL, { sessionKey: sessionKey() });
    expect(selected.connectionId).toBe(a.id);
    selected.releaseSelection?.();
  });

  it("does not use an idle cooling account even when the healthy account is busy", async () => {
    const cooling = await account("cooling", 0), busy = await account("busy", 0);
    limiter.pauseAccountQueue(cooling.id, Date.now() + 30_000);
    await occupy(busy, 4);
    const selected = await selection.getProviderCredentials("codex", null, MODEL, { sessionKey: sessionKey() });
    expect(selected.connectionId).toBe(busy.id);
    selected.releaseSelection?.();
  });

  it("chooses the shorter queue when all limited accounts are full, even with overload history", async () => {
    const a = await account("queued"), b = await account("not-queued");
    await occupy(a);
    await occupy(b);
    await db.updateProviderConnection(b.id, { errorCode: 503, lastErrorAt: new Date().toISOString() });
    const abort = new AbortController();
    const waiting = loads.acquireAccountSlot({ scope: "account", id: a.id, limit: 1, deadline: Date.now() + 1500, signal: abort.signal });
    waiting.catch(() => {});
    try {
      expect(limiter.__test__.snapshot("account", a.id).queued).toBe(1);
      const selected = await selection.getProviderCredentials("codex", null, MODEL, { sessionKey: sessionKey() });
      expect(selected.connectionId).toBe(b.id);
      selected.releaseSelection?.();
    } finally {
      abort.abort();
      await expect(waiting).rejects.toMatchObject({ code: "queue_aborted" });
    }
  });

  it.each(["inherit", "quota-priority", "fill-first", "least-loaded", "round-robin"])("deprioritizes recovered overload accounts ahead of the %s strategy", async accountStrategy => {
    const a = await account("overloaded-high-quota"), b = await account("healthy-low-quota");
    await db.updateSettings({ localCodexRouting: { accountStrategy, quotaFailover: false }, fallbackStrategy: "round-robin" });
    await db.updateProviderConnection(a.id, { errorCode: 503, lastErrorAt: new Date().toISOString() });
    await db.updateProviderConnection(a.id, { testStatus: "active" });
    const { loadConnectionUsage } = await import("@/lib/providerUsage.js");
    loadConnectionUsage.mockImplementation(async connection => ({ quotas: { session: { used: connection.id === a.id ? 0 : 80, total: 100 } } }));
    for (let i = 0; i < 3; i++) {
      const selected = await selection.getProviderCredentials("codex", null, MODEL, { sessionKey: sessionKey(`new-${i}`) });
      expect(selected.connectionId).toBe(b.id);
      selected.releaseSelection?.();
    }
  });

  it("moves a binding off a recovered overload account when a clean account is available", async () => {
    const a = await account("a"), b = await account("b");
    await sessions.bindSession(sessionKey(), "codex", a.id);
    await db.updateProviderConnection(a.id, { errorCode: 503, lastErrorAt: new Date().toISOString() });
    await db.updateProviderConnection(a.id, { testStatus: "active" });
    const selected = await selection.getProviderCredentials("codex", null, MODEL, { sessionKey: sessionKey() });
    expect(selected.connectionId).toBe(b.id);
    expect((await sessions.getSessionBinding(sessionKey())).connectionId).toBe(b.id);
    selected.releaseSelection?.();
  });

  it("uses an overload account as fallback but never while it is cooling down", async () => {
    const a = await account("a"), b = await account("b");
    await db.updateProviderConnection(a.id, { errorCode: 503, lastErrorAt: new Date().toISOString() });
    await db.updateProviderConnection(b.id, { errorCode: 429, [`modelLock_${MODEL}`]: new Date(Date.now() + 30_000).toISOString() });
    const selected = await selection.getProviderCredentials("codex", null, MODEL);
    expect(selected.connectionId).toBe(a.id);
    limiter.pauseAccountQueue(a.id, Date.now() + 30_000);
    expect(await selection.getProviderCredentials("codex", null, MODEL)).toMatchObject({ allRateLimited: true });
  });

  it("restores ordinary selection after clearing overload history", async () => {
    const a = await account("a"), b = await account("b");
    await db.updateSettings({ localCodexRouting: { accountStrategy: "fill-first", quotaFailover: false } });
    await db.updateProviderConnection(a.id, { errorCode: 503, lastErrorAt: new Date().toISOString() });
    const warningRepo = await import("@/lib/db/repos/accountOverloadWarningsRepo.js");
    expect((await selection.getProviderCredentials("codex", null, MODEL)).connectionId).toBe(b.id);
    const warning = (await warningRepo.getAccountOverloadWarnings(a.id))[a.id];
    await warningRepo.dismissAccountOverloadWarning(a.id, warning.eventId);
    expect((await selection.getProviderCredentials("codex", null, MODEL)).connectionId).toBe(a.id);
  });

  it("moves a bound session after 503 and keeps later requests on the replacement", async () => {
    const a = await account("a"), b = await account("b");
    await sessions.bindSession(sessionKey(), "codex", a.id);
    const failure = overloaded();
    const cancel = vi.spyOn(failure.response.body, "cancel");
    upstream.mockResolvedValueOnce(failure).mockImplementation(async () => success());

    expect(await (await send()).json()).toEqual({ ok: true });
    expect(upstream.mock.calls.map(([args]) => args.connectionId)).toEqual([a.id, b.id]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(await sessions.getSessionBinding(sessionKey())).toEqual({ provider: "codex", connectionId: b.id });
    expect(loads.getAccountActiveCount(a.id)).toBe(0);
    expect(loads.getAccountActiveCount(b.id)).toBe(0);
    expect((await db.getProviderConnectionById(a.id)).errorCode).toBe(503);

    expect(await (await send()).json()).toEqual({ ok: true });
    expect(upstream.mock.calls.at(-1)[0].connectionId).toBe(b.id);
  });

  it("skips an account already cooling down from a 503 before calling upstream", async () => {
    const a = await account("a"), b = await account("b");
    await sessions.bindSession(sessionKey(), "codex", a.id);
    await db.updateProviderConnection(a.id, { errorCode: 503, modelLock___all: new Date(Date.now() + 30_000).toISOString() });
    upstream.mockResolvedValue(success());

    expect(await (await send()).json()).toEqual({ ok: true });
    expect(upstream).toHaveBeenCalledOnce();
    expect(upstream.mock.calls[0][0].connectionId).toBe(b.id);
    expect((await sessions.getSessionBinding(sessionKey())).connectionId).toBe(b.id);
  });

  it.each([429, 503])("never binds a new session to an account with a persisted %i cooldown", async (status) => {
    const a = await account("a"), b = await account("b");
    await db.updateProviderConnection(a.id, { errorCode: status, [`modelLock_${MODEL}`]: new Date(Date.now() + 30_000).toISOString() });

    const credentials = await selection.getProviderCredentials("codex", null, MODEL, { sessionKey: sessionKey() });
    expect(credentials.connectionId).toBe(b.id);
    credentials.releaseSelection?.();
    expect((await sessions.getSessionBinding(sessionKey())).connectionId).toBe(b.id);
  });

  it.each([false, true])("skips runtime queue cooldown even when the database is healthy (existing binding: %s)", async (bound) => {
    const a = await account("a"), b = await account("b");
    if (bound) await sessions.bindSession(sessionKey(), "codex", a.id);
    limiter.pauseAccountQueue(a.id, Date.now() + 30_000);

    const credentials = await selection.getProviderCredentials("codex", null, MODEL, { sessionKey: sessionKey() });
    expect(credentials.connectionId).toBe(b.id);
    credentials.releaseSelection?.();
    expect((await sessions.getSessionBinding(sessionKey())).connectionId).toBe(b.id);
  });

  it("leaves a new session unbound when every account is cooling down", async () => {
    const a = await account("a");
    limiter.pauseAccountQueue(a.id, Date.now() + 30_000);

    expect(await selection.getProviderCredentials("codex", null, MODEL, { sessionKey: sessionKey() }))
      .toMatchObject({ allRateLimited: true, retryAfter: expect.any(String) });
    expect(await sessions.getSessionBinding(sessionKey())).toBeNull();
    expect(global.__ninerouterAccountSelection.reservations.size).toBe(0);
  });

  it("tries each account at most once even if an earlier cooldown clears during failover", async () => {
    const a = await account("a"), b = await account("b");
    await sessions.bindSession(sessionKey(), "codex", a.id);
    upstream.mockImplementation(async ({ connectionId }) => {
      if (connectionId === b.id) await db.updateProviderConnection(a.id, { testStatus: "active" });
      return overloaded();
    });

    const response = await send();
    expect(response.status).toBe(503);
    expect((await response.json()).error.message).toContain("暂无其他可用账号可切换");
    expect(upstream.mock.calls.map(([args]) => args.connectionId)).toEqual([a.id, b.id]);
    expect(loads.getAccountActiveCount(a.id)).toBe(0);
    expect(loads.getAccountActiveCount(b.id)).toBe(0);
  });

  it("preserves the persisted binding and returns promptly when there is no replacement", async () => {
    const a = await account("a");
    await sessions.bindSession(sessionKey(), "codex", a.id);
    upstream.mockResolvedValue(overloaded());

    const response = await send();
    expect(response.status).toBe(503);
    expect((await response.json()).error.message).toContain("暂无其他可用账号可切换");
    expect(response.headers.get("Retry-After")).not.toBeNull();
    expect(upstream).toHaveBeenCalledOnce();
    expect((await sessions.getSessionBinding(sessionKey())).connectionId).toBe(a.id);
  });

  it.each([400, 429])("keeps existing session behavior for a %i without quota failover", async (status) => {
    const a = await account("a");
    await account("b");
    await sessions.bindSession(sessionKey(), "codex", a.id);
    upstream.mockResolvedValue({ success: false, status, error: "request failed", response: Response.json({}, { status }) });

    const response = await send();
    expect(response.status).toBe(status);
    expect(upstream).toHaveBeenCalledOnce();
    expect((await sessions.getSessionBinding(sessionKey())).connectionId).toBe(a.id);
  });

  it("preserves automatic migration on quota exhaustion when it is enabled", async () => {
    const a = await account("a"), b = await account("b");
    await db.updateSettings({ localCodexRouting: { accountStrategy: "least-loaded", quotaFailover: true } });
    await sessions.bindSession(sessionKey(), "codex", a.id);
    upstream.mockResolvedValueOnce({ success: false, status: 429, error: "usage_limit_reached", response: Response.json({}, { status: 429 }) })
      .mockResolvedValueOnce(success());

    expect(await (await send()).json()).toEqual({ ok: true });
    expect(upstream.mock.calls.map(([args]) => args.connectionId)).toEqual([a.id, b.id]);
    expect((await sessions.getSessionBinding(sessionKey())).connectionId).toBe(b.id);
  });

  it("only migrates to accounts that have the requested model enabled", async () => {
    const a = await account("a"), b = await account("b"), c = await account("c");
    await db.updateProviderConnection(b.id, { providerSpecificData: { enabledModels: ["gpt-6-luna"] } });
    await sessions.bindSession(sessionKey(), "codex", a.id);
    upstream.mockResolvedValueOnce(overloaded()).mockResolvedValueOnce(success());

    expect(await (await send()).json()).toEqual({ ok: true });
    expect(upstream.mock.calls.map(([args]) => args.connectionId)).toEqual([a.id, c.id]);
    expect((await sessions.getSessionBinding(sessionKey())).connectionId).toBe(c.id);
  });

  it("releases a selected account's slot when it becomes overloaded before the upstream call", async () => {
    const a = await account("a"), b = await account("b");
    await sessions.bindSession(sessionKey(), "codex", a.id);
    refresh.mockImplementationOnce(async (_provider, credentials) => {
      await db.updateProviderConnection(a.id, { errorCode: 503, modelLock___all: new Date(Date.now() + 30_000).toISOString() });
      return credentials;
    });
    upstream.mockResolvedValue(success());

    expect(await (await send()).json()).toEqual({ ok: true });
    expect(upstream).toHaveBeenCalledOnce();
    expect(upstream.mock.calls[0][0].connectionId).toBe(b.id);
    expect(loads.getAccountActiveCount(a.id)).toBe(0);
    expect(limiter.__test__.snapshot("account", a.id)?.active || 0).toBe(0);
  });

  it("balances concurrent requests in one overloaded session across idle replacements", async () => {
    const a = await account("a"), b = await account("b");
    const c = await account("c");
    await sessions.bindSession(sessionKey(), "codex", a.id);
    await db.updateProviderConnection(a.id, { errorCode: 503, modelLock___all: new Date(Date.now() + 30_000).toISOString() });

    const selected = await Promise.all([1, 2].map(() => selection.getProviderCredentials("codex", null, MODEL, { sessionKey: sessionKey() })));
    expect(selected.map(credentials => credentials.connectionId)).toEqual([b.id, c.id]);
    selected.forEach(credentials => credentials.releaseSelection?.());
    expect((await sessions.getSessionBinding(sessionKey())).connectionId).toBe(c.id);
  });

  it("keeps provider bindings isolated when migrating an overloaded account", async () => {
    const a = await account("a");
    await sessions.bindSession(sessionKey(), "other-provider", a.id);
    expect(await selection.getProviderCredentials("codex", null, MODEL, { sessionKey: sessionKey() }))
      .toMatchObject({ sessionUnavailable: true, lastErrorCode: 409 });
    expect((await sessions.getSessionBinding(sessionKey())).provider).toBe("other-provider");
  });
});
