import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { exchange } = vi.hoisted(() => ({ exchange: vi.fn() }));
vi.mock("@/lib/oauth/providers", async importOriginal => ({
  ...await importOriginal(), exchangeTokens: exchange,
}));

const originalDataDir = process.env.DATA_DIR;
let tempDir, db, api, proxy, account, key, tokens, listeners, callback, httpSpy;

beforeEach(async () => {
  listeners = Object.fromEntries(["beforeExit", "exit", "SIGINT", "SIGTERM"].map(event => [event, new Set(process.rawListeners(event))]));
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-codex-relogin-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  key = await db.createApiKey("dedicated-owner", "test-machine");
  account = await db.createProviderConnection({
    provider: "codex", authType: "oauth", name: "My account", email: "owner@example.com",
    accessToken: "old-access", refreshToken: "old-refresh", idToken: "old-id",
    exclusiveApiKeyIds: [key.id], priority: 5, isActive: false, isDegraded: true,
    degradedMarkedAt: "2026-10-13T07:00:00.000Z",
    minRequestIntervalMs: 2000, accountCooldownMinMs: 40000,
    providerSpecificData: { chatgptAccountId: "workspace-1", proxyPoolId: "original-proxy", custom: "keep" },
  });
  await db.updateProviderConnection(account.id, {
    maxConcurrency: 3, testStatus: "unavailable", errorCode: 401, lastError: "invalid credentials",
    lastErrorAt: new Date().toISOString(), modelLock___all: new Date(Date.now() + 60000).toISOString(),
  });
  tokens = {
    accessToken: "new-access", refreshToken: "new-refresh", idToken: "new-id", expiresIn: 3600,
    email: "owner@example.com", providerSpecificData: { chatgptAccountId: "workspace-1", chatgptPlanType: "pro" },
  };
  exchange.mockReset().mockImplementation(async () => tokens);
  callback = null;
  httpSpy = vi.spyOn(http, "createServer").mockImplementation(handler => {
    callback = handler;
    const server = { listen: vi.fn((_port, _host, ready) => ready()), on: vi.fn(), close: vi.fn() };
    return server;
  });
  api = await import("@/app/api/oauth/[provider]/[action]/route.js");
  proxy = await import("@/lib/oauth/utils/server.js");
});

afterEach(async () => {
  proxy?.stopCodexProxy();
  httpSpy?.mockRestore();
  global._dbAdapter?.instance?.close?.();
  delete global._dbAdapter;
  for (const [event, original] of Object.entries(listeners)) {
    for (const listener of process.rawListeners(event)) if (!original.has(listener)) process.removeListener(event, listener);
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function exchangeCode(patch = {}, provider = "codex") {
  return api.POST(new Request(`http://localhost/api/oauth/${provider}/exchange`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "authorization-code", codeVerifier: "verifier", redirectUri: "http://localhost:1455/auth/callback", state: "login-state", connectionId: account.id, ...patch }),
  }), { params: Promise.resolve({ provider, action: "exchange" }) });
}

async function startProxy(connectionId = account.id) {
  const params = new URLSearchParams({ app_port: "20128", state: "proxy-state", code_verifier: "verifier", redirect_uri: "http://localhost:1455/auth/callback", connection_id: connectionId });
  return api.GET(new Request(`http://localhost/api/oauth/codex/start-proxy?${params}`), { params: Promise.resolve({ provider: "codex", action: "start-proxy" }) });
}

async function finishProxy() {
  const response = { writeHead: vi.fn(), end: vi.fn() };
  await callback({ url: "/auth/callback?state=proxy-state&code=authorization-code" }, response);
  return proxy.getCodexSessionStatus("proxy-state");
}

function expectPreserved(connection) {
  expect(connection).toMatchObject({
    id: account.id, name: "My account", provider: "codex", isActive: false, isDegraded: true,
    degradedMarkedAt: "2026-10-13T07:00:00.000Z",
    priority: 5, exclusiveApiKeyIds: [key.id], maxConcurrency: 3,
    minRequestIntervalMs: 2000, accountCooldownMinMs: 40000,
    providerSpecificData: { proxyPoolId: "original-proxy", custom: "keep", chatgptAccountId: "workspace-1" },
    testStatus: "active", errorCode: null, lastError: null, modelLock___all: null,
  });
}

describe("Codex account relogin", () => {
  it("replaces credentials on the original disabled account without changing its configuration", async () => {
    const response = await exchangeCode();
    expect(response.status).toBe(200);
    const saved = await db.getProviderConnectionById(account.id);
    expectPreserved(saved);
    expect(saved).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh", idToken: "new-id", providerSpecificData: { chatgptPlanType: "pro" } });
    expect(Date.parse(saved.expiresAt)).toBeGreaterThan(Date.now());
    expect(await db.getProviderConnections({ provider: "codex" })).toHaveLength(1);
    const text = JSON.stringify(await response.json());
    for (const token of ["new-access", "new-refresh", "new-id"]) expect(text).not.toContain(token);
  });

  it("updates only the selected row when duplicate token accounts share the same identity", async () => {
    const duplicate = await db.createProviderConnection({ provider: "codex", authType: "access_token", email: account.email, accessToken: "duplicate-token", providerSpecificData: account.providerSpecificData });
    expect((await exchangeCode()).status).toBe(200);
    expect((await db.getProviderConnectionById(duplicate.id)).accessToken).toBe("duplicate-token");
    expect((await db.getProviderConnectionById(account.id)).accessToken).toBe("new-access");
  });

  it.each(["another email", "missing email", "another workspace", "missing workspace"])("rejects %s without changing credentials or creating another account", async mismatch => {
    if (mismatch === "another email") tokens.email = "other@example.com";
    if (mismatch === "missing email") delete tokens.email;
    if (mismatch === "another workspace") tokens.providerSpecificData.chatgptAccountId = "workspace-2";
    if (mismatch === "missing workspace") delete tokens.providerSpecificData.chatgptAccountId;
    expect((await exchangeCode()).status).toBe(409);
    expect((await db.getProviderConnectionById(account.id)).accessToken).toBe("old-access");
    expect(await db.getProviderConnections({ provider: "codex" })).toHaveLength(1);
  });

  it("accepts normalized email casing", async () => {
    tokens.email = "OWNER@example.com";
    expect((await exchangeCode()).status).toBe(200);
  });

  it.each([null, "", 123, "deleted-id"])("rejects invalid targets before exchanging credentials: %s", async connectionId => {
    expect((await exchangeCode({ connectionId })).status).toBe(connectionId === "deleted-id" ? 404 : 400);
    expect(exchange).not.toHaveBeenCalled();
  });

  it("rejects accounts belonging to another provider", async () => {
    const other = await db.createProviderConnection({ provider: "claude", authType: "oauth", email: account.email });
    expect((await exchangeCode({ connectionId: other.id })).status).toBe(400);
    expect((await exchangeCode({}, "claude")).status).toBe(400);
    expect(exchange).not.toHaveBeenCalled();
  });

  it("keeps the original credentials when authentication fails", async () => {
    exchange.mockRejectedValue(new Error("Authorization code expired"));
    expect((await exchangeCode()).status).toBe(500);
    expect((await db.getProviderConnectionById(account.id)).refreshToken).toBe("old-refresh");
  });

  it("supports pasting a new website token and removes revoked refresh credentials", async () => {
    const payload = { email: account.email, account_id: "workspace-1", exp: Math.floor(Date.now() / 1000) + 3600 };
    const token = "eyJhbGciOiJub25lIn0." + Buffer.from(JSON.stringify(payload)).toString("base64url") + ".signature";
    expect((await exchangeCode({ code: token })).status).toBe(200);
    const saved = await db.getProviderConnectionById(account.id);
    expectPreserved(saved);
    expect(saved).toMatchObject({ authType: "access_token", accessToken: token, refreshToken: null, idToken: null });
    expect(Date.parse(saved.expiresAt)).toBe(payload.exp * 1000);
    expect(exchange).not.toHaveBeenCalled();
  });

  it("allows legacy rows without workspace identity to gain the verified account identity", async () => {
    await db.updateProviderConnection(account.id, { providerSpecificData: { proxyPoolId: "original-proxy" } });
    expect((await exchangeCode()).status).toBe(200);
    expect((await db.getProviderConnectionById(account.id)).providerSpecificData.chatgptAccountId).toBe("workspace-1");
  });

  it("keeps ordinary add-account login available without a relogin target", async () => {
    tokens.email = "new@example.com";
    tokens.providerSpecificData.chatgptAccountId = "workspace-2";
    expect((await exchangeCode({ connectionId: undefined })).status).toBe(200);
    expect(await db.getProviderConnections({ provider: "codex" })).toHaveLength(2);
    expect((await db.getProviderConnectionById(account.id)).accessToken).toBe("old-access");
  });

  it("preserves the target through server-side callback exchange", async () => {
    expect((await startProxy()).status).toBe(200);
    expect(proxy.getCodexSessionStatus("proxy-state").reloginConnectionId).toBe(account.id);
    expect(await finishProxy()).toMatchObject({ status: "done", connectionId: account.id });
    expectPreserved(await db.getProviderConnectionById(account.id));
    expect(await db.getProviderConnections({ provider: "codex" })).toHaveLength(1);
  });

  it("reports wrong-account login through the proxy without replacing the original row", async () => {
    await startProxy();
    tokens.email = "other@example.com";
    expect(await finishProxy()).toMatchObject({ status: "error" });
    expect((await db.getProviderConnectionById(account.id)).accessToken).toBe("old-access");
    expect(await db.getProviderConnections({ provider: "codex" })).toHaveLength(1);
  });

  it("does not recreate a target deleted while the login window was open", async () => {
    await startProxy();
    await db.deleteProviderConnection(account.id);
    expect(await finishProxy()).toMatchObject({ status: "error" });
    expect(await db.getProviderConnections({ provider: "codex" })).toHaveLength(0);
  });
});
