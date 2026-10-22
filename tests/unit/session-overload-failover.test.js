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
    method: "POST", headers: { "Content-Type": "application/json", ...(sessionId ? { "x-session-id": sessionId } : {}) }, body: JSON.stringify(body),
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

describe("credits policy during account routing", () => {
  it.each([false, true])("enforces the credits opt-in with the inherited strategy (allowed: %s)", async allowCredits => {
    const connection = await account("credits-account", 0);
    await db.updateSettings({ localCodexRouting: { accountStrategy: "inherit", allowCredits } });
    const { loadConnectionUsage } = await import("@/lib/providerUsage.js");
    loadConnectionUsage.mockResolvedValue({
      limitReached: true,
      credits: { hasCredits: true, unlimited: false, balance: 10 },
      quotas: { session: { used: 100, total: 100, resetAt: "2030-01-01T00:00:00Z" } },
    });
    upstream.mockResolvedValue(success());
    const response = await send(null);
    expect(response.status).toBe(allowCredits ? 200 : 429);
    if (allowCredits) expect(upstream).toHaveBeenCalledWith(expect.objectContaining({ credentials: expect.objectContaining({ connectionId: connection.id }) }));
    else expect(upstream).not.toHaveBeenCalled();
    loadConnectionUsage.mockResolvedValue(null);
  });

  it("selects an account with included quota when credits are disabled", async () => {
    const spent = await account("spent", 0), fresh = await account("fresh", 0);
    await db.updateSettings({ localCodexRouting: { accountStrategy: "inherit", allowCredits: false } });
    const { loadConnectionUsage } = await import("@/lib/providerUsage.js");
    loadConnectionUsage.mockImplementation(async connection => ({
      credits: { hasCredits: true, unlimited: false, balance: 10 },
      quotas: { session: { used: connection.id === spent.id ? 100 : 10, total: 100, resetAt: "2030-01-01T00:00:00Z" } },
    }));
    const selected = await selection.getProviderCredentials("codex", null, MODEL);
    expect(selected.connectionId).toBe(fresh.id);
    selected.releaseSelection?.();
    loadConnectionUsage.mockResolvedValue(null);
  });
});

describe("stable account bindings during overload", () => {
  it.each(["inherit", "quota-priority", "fill-first", "least-loaded", "round-robin"])("balances new sessions but preserves busy bindings with %s", async accountStrategy => {
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
      expect(selected.connectionId).toBe(bound ? busy.id : idle.id);
      expect((await sessions.getSessionBinding(key)).connectionId).toBe(bound ? busy.id : idle.id);
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

  it("keeps a busy binding even when another account has less work", async () => {
    const busy = await account("busy", 0), lessBusy = await account("less-busy", 0);
    await db.updateSettings({ localCodexRouting: { accountStrategy: "quota-priority", quotaFailover: false } });
    await db.updateProviderConnection(lessBusy.id, { errorCode: 503, lastErrorAt: new Date().toISOString() });
    await occupy(busy, 4);
    await occupy(lessBusy, 1);
    await sessions.bindSession(sessionKey(), "codex", busy.id);
    const selected = await selection.getProviderCredentials("codex", null, MODEL, { sessionKey: sessionKey() });
    expect(selected.connectionId).toBe(busy.id);
    expect((await sessions.getSessionBinding(sessionKey())).connectionId).toBe(busy.id);
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

  it("keeps a recovered binding despite its overload history", async () => {
    const a = await account("a");
    await account("b");
    await sessions.bindSession(sessionKey(), "codex", a.id);
    await db.updateProviderConnection(a.id, { errorCode: 503, lastErrorAt: new Date().toISOString() });
    await db.updateProviderConnection(a.id, { testStatus: "active" });
    const selected = await selection.getProviderCredentials("codex", null, MODEL, { sessionKey: sessionKey() });
    expect(selected.connectionId).toBe(a.id);
    expect((await sessions.getSessionBinding(sessionKey())).connectionId).toBe(a.id);
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

  it.each([false, true])("returns 503 without switching accounts or losing the binding (quota failover: %s)", async quotaFailover => {
    const a = await account("a"), b = await account("b");
    await db.updateSettings({ localCodexRouting: { accountStrategy: "least-loaded", quotaFailover } });
    await sessions.bindSession(sessionKey(), "codex", a.id);
    const failure = overloaded();
    const cancel = vi.spyOn(failure.response.body, "cancel");
    upstream.mockResolvedValueOnce(failure).mockImplementation(async () => success());

    const response = await send();
    expect(response.status).toBe(503);
    expect((await response.json()).error.message).toContain(OVERLOAD);
    expect(response.headers.get("Retry-After")).not.toBeNull();
    expect(upstream.mock.calls.map(([args]) => args.connectionId)).toEqual([a.id]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(await sessions.getSessionBinding(sessionKey())).toEqual({ provider: "codex", connectionId: a.id });
    expect(loads.getAccountActiveCount(a.id)).toBe(0);
    expect(loads.getAccountActiveCount(b.id)).toBe(0);
    expect((await db.getProviderConnectionById(a.id)).errorCode).toBe(503);

    expect((await send()).status).toBe(503);
    expect(upstream).toHaveBeenCalledOnce();
    expect((await db.getProviderConnectionById(b.id)).errorCode).toBeFalsy();

    limiter.__test__.reset();
    await db.updateProviderConnection(a.id, { testStatus: "active", errorCode: null, modelLock___all: null });
    expect(await (await send()).json()).toEqual({ ok: true });
    expect(upstream.mock.calls.at(-1)[0].connectionId).toBe(a.id);
  });

  it("returns the bound account's cooldown without contacting another account", async () => {
    const a = await account("a");
    await account("b");
    await sessions.bindSession(sessionKey(), "codex", a.id);
    await db.updateProviderConnection(a.id, { errorCode: 503, modelLock___all: new Date(Date.now() + 30_000).toISOString() });
    upstream.mockResolvedValue(success());

    const response = await send();
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).not.toBeNull();
    expect(upstream).not.toHaveBeenCalled();
    expect((await sessions.getSessionBinding(sessionKey())).connectionId).toBe(a.id);
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
    expect(credentials).toMatchObject(bound ? { sessionUnavailable: true, lastErrorCode: 503, retryAfter: expect.any(String) } : { connectionId: b.id });
    credentials.releaseSelection?.();
    expect((await sessions.getSessionBinding(sessionKey())).connectionId).toBe(bound ? a.id : b.id);
  });

  it("leaves a new session unbound when every account is cooling down", async () => {
    const a = await account("a");
    limiter.pauseAccountQueue(a.id, Date.now() + 30_000);

    expect(await selection.getProviderCredentials("codex", null, MODEL, { sessionKey: sessionKey() }))
      .toMatchObject({ allRateLimited: true, retryAfter: expect.any(String) });
    expect(await sessions.getSessionBinding(sessionKey())).toBeNull();
    expect(global.__ninerouterAccountSelection.reservations.size).toBe(0);
  });

  it("does not spread one overloaded request across the other nine accounts", async () => {
    const a = await account("a");
    const others = [];
    for (let i = 0; i < 9; i++) others.push(await account(`other-${i}`));
    await sessions.bindSession(sessionKey(), "codex", a.id);
    upstream.mockImplementation(async () => overloaded());

    const response = await send();
    expect(response.status).toBe(503);
    expect((await response.json()).error.message).toContain(OVERLOAD);
    expect(upstream.mock.calls.map(([args]) => args.connectionId)).toEqual([a.id]);
    expect(loads.getAccountActiveCount(a.id)).toBe(0);
    for (const other of others) expect((await db.getProviderConnectionById(other.id)).errorCode).toBeFalsy();
    expect(global.__ninerouterAccountSelection.reservations.size).toBe(0);
  });

  it("does not retry 503 on another account even without a session identifier", async () => {
    await account("a");
    await account("b");
    upstream.mockImplementation(async () => overloaded());
    expect((await send(null)).status).toBe(503);
    expect(upstream).toHaveBeenCalledOnce();
    expect(global.__ninerouterAccountSelection.reservations.size).toBe(0);
  });

  it("preserves the persisted binding and returns promptly when there is no replacement", async () => {
    const a = await account("a");
    await sessions.bindSession(sessionKey(), "codex", a.id);
    upstream.mockResolvedValue(overloaded());

    const response = await send();
    expect(response.status).toBe(503);
    expect((await response.json()).error.message).toContain(OVERLOAD);
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

  it.each([
    [400, '[400]: {"error":{"message":"Missing required parameter: \'input[37].status\'.","code":"missing_required_parameter"}}', "请求参数或协议格式错误。"],
    [429, "rate_limit_exceeded", "请求频率受限。"],
    [429, "usage_limit_reached", "账号额度或余额不足。"],
  ])("appends only the matching hint to a bound session's %i error", async (status, message, hint) => {
    const a = await account("a");
    await sessions.bindSession(sessionKey(), "codex", a.id);
    upstream.mockResolvedValue({ success: false, status, error: message, response: Response.json({}, { status }) });

    const response = await send();
    expect(response.status).toBe(status);
    expect((await response.json()).error.message).toBe(`${message}\n提示：${hint}`);
    expect(upstream).toHaveBeenCalledOnce();
    expect((await sessions.getSessionBinding(sessionKey())).connectionId).toBe(a.id);
  });

  it.each([
    [OVERLOAD, "上游服务过载。"],
    ["[503]: upstream connect error or disconnect/reset before headers. reset reason: connection timeout", "连接或响应超时。"],
  ])("preserves the raw error through cooldown and keeps hints out of logs: %s", async (message, hint) => {
    const a = await account("a");
    await db.updateProviderConnection(a.id, { accountCooldownMinMs: 30_000, accountCooldownMaxMs: 30_000 });
    await sessions.bindSession(sessionKey(), "codex", a.id);
    upstream.mockResolvedValue({ success: false, status: 503, error: message, response: Response.json({}, { status: 503 }) });

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await send();
      expect(response.status).toBe(503);
      const seconds = Number(response.headers.get("Retry-After"));
      expect(seconds).toBeGreaterThan(0);
      expect((await response.json()).error.message).toBe(`${message}\n提示：${hint} 请在 ${seconds} 秒后重试。`);
    }
    expect(upstream).toHaveBeenCalledOnce();
    expect((await sessions.getSessionBinding(sessionKey())).connectionId).toBe(a.id);
    const { getRequestErrors } = await import("@/lib/db/repos/requestErrorsRepo.js");
    const { items } = await getRequestErrors();
    expect(items).toHaveLength(1);
    expect(items[0].message).toBe(message);
  });

  it("uses the thrown network cause without rewriting the error message", async () => {
    await account("a");
    upstream.mockRejectedValue(new Error("fetch failed", { cause: { code: "ETIMEDOUT" } }));

    const response = await send();
    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toBe("fetch failed\n提示：连接或响应超时。");
    const { getRequestErrors } = await import("@/lib/db/repos/requestErrorsRepo.js");
    const { items } = await getRequestErrors();
    expect(items).toHaveLength(1);
    expect(items[0].message).toBe("fetch failed");
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
    await db.updateSettings({ localCodexRouting: { accountStrategy: "least-loaded", quotaFailover: true } });
    await db.updateProviderConnection(b.id, { providerSpecificData: { enabledModels: ["gpt-6-luna"] } });
    await sessions.bindSession(sessionKey(), "codex", a.id);
    upstream.mockResolvedValueOnce({ success: false, status: 429, error: "usage_limit_reached", response: Response.json({}, { status: 429 }) }).mockResolvedValueOnce(success());

    expect(await (await send()).json()).toEqual({ ok: true });
    expect(upstream.mock.calls.map(([args]) => args.connectionId)).toEqual([a.id, c.id]);
    expect((await sessions.getSessionBinding(sessionKey())).connectionId).toBe(c.id);
  });

  it.each([false, true])("releases the slot without switching when an account locks before the upstream call (bound: %s)", async bound => {
    const a = await account("a");
    await account("b");
    if (bound) await sessions.bindSession(sessionKey(), "codex", a.id);
    refresh.mockImplementationOnce(async (_provider, credentials) => {
      await db.updateProviderConnection(a.id, { errorCode: 503, modelLock___all: new Date(Date.now() + 30_000).toISOString() });
      return credentials;
    });
    upstream.mockResolvedValue(success());

    expect((await send(bound ? "failover-session" : null)).status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
    if (bound) expect((await sessions.getSessionBinding(sessionKey())).connectionId).toBe(a.id);
    expect(loads.getAccountActiveCount(a.id)).toBe(0);
    expect(limiter.__test__.snapshot("account", a.id)?.active || 0).toBe(0);
  });

  it("keeps concurrent requests in a cooling session away from every upstream account", async () => {
    const a = await account("a");
    await account("b");
    await account("c");
    await sessions.bindSession(sessionKey(), "codex", a.id);
    await db.updateProviderConnection(a.id, { errorCode: 503, modelLock___all: new Date(Date.now() + 30_000).toISOString() });

    const selected = await Promise.all([1, 2].map(() => selection.getProviderCredentials("codex", null, MODEL, { sessionKey: sessionKey() })));
    expect(selected).toEqual([expect.objectContaining({ sessionUnavailable: true }), expect.objectContaining({ sessionUnavailable: true })]);
    selected.forEach(credentials => credentials.releaseSelection?.());
    expect((await sessions.getSessionBinding(sessionKey())).connectionId).toBe(a.id);
    expect(global.__ninerouterAccountSelection.reservations.size).toBe(0);
  });

  it("keeps simultaneous requests in a healthy session on its first selected account", async () => {
    const a = await account("a", 0);
    await account("b", 0);
    await account("c", 0);
    const selected = await Promise.all([1, 2, 3].map(() => selection.getProviderCredentials("codex", null, MODEL, { sessionKey: sessionKey() })));
    expect(selected.map(credentials => credentials.connectionId)).toEqual([a.id, a.id, a.id]);
    selected.forEach(credentials => credentials.releaseSelection?.());
    expect((await sessions.getSessionBinding(sessionKey())).connectionId).toBe(a.id);
    expect(global.__ninerouterAccountSelection.reservations.size).toBe(0);
  });

  it("keeps bindings isolated between providers", async () => {
    const a = await account("a");
    await sessions.bindSession(sessionKey(), "other-provider", a.id);
    expect(await selection.getProviderCredentials("codex", null, MODEL, { sessionKey: sessionKey() }))
      .toMatchObject({ sessionUnavailable: true, lastErrorCode: 409 });
    expect((await sessions.getSessionBinding(sessionKey())).provider).toBe("other-provider");
  });
});
