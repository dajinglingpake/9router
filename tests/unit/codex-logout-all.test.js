import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), refresh: vi.fn(), proxy: vi.fn() }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
vi.mock("@/lib/providerUsage", () => ({ refreshAndUpdateCredentials: mocks.refresh }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: mocks.proxy }));

const originalDataDir = process.env.DATA_DIR;
let directory, db, account, api, logout, key, previousListeners, sessions, sessionApi;
beforeEach(async () => {
  previousListeners = Object.fromEntries(["beforeExit", "exit", "SIGINT", "SIGTERM"].map(event => [event, new Set(process.rawListeners(event))]));
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "9router-codex-logout-"));
  process.env.DATA_DIR = directory;
  delete global._dbAdapter;
  vi.resetModules();
  vi.clearAllMocks();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  key = await db.createApiKey("owner", "test-machine");
  account = await db.createProviderConnection({ provider: "codex", authType: "oauth", email: "owner@example.com",
    name: "Original account", accessToken: "secret-access", refreshToken: "secret-refresh", idToken: "secret-id",
    isActive: true, priority: 3, maxConcurrency: 2, exclusiveApiKeyIds: [key.id],
    providerSpecificData: { chatgptAccountId: "workspace-original", workspaceId: "workspace-selected", proxyPoolId: "original-proxy", enabledModels: ["gpt-6-luna"] },
  });
  account = await db.updateProviderConnection(account.id, { maxConcurrency: 2 });
  mocks.fetch.mockReset().mockResolvedValue(new Response('{"success":true}', { status: 200 }));
  mocks.refresh.mockReset().mockImplementation(async connection => ({ connection, refreshed: false }));
  mocks.proxy.mockReset().mockResolvedValue({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.invalid:8080", strictProxy: true });
  ({ logoutCodexConnection: logout } = await import("@/lib/codexSessions"));
  ({ getCodexSessions: sessions } = await import("@/lib/codexSessions"));
  api = await import("@/app/api/providers/[id]/logout-all/route.js");
  sessionApi = await import("@/app/api/providers/[id]/sessions/route.js");
});

afterEach(() => {
  global._dbAdapter?.instance?.close?.();
  delete global._dbAdapter;
  for (const [event, listeners] of Object.entries(previousListeners)) {
    for (const listener of process.rawListeners(event)) if (!listeners.has(listener)) process.removeListener(event, listener);
  }
  fs.rmSync(directory, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function request(body = { confirm: true }, headers = {}) {
  return new Request("http://localhost/api/providers/account/logout-all", { method: "POST",
    headers: { Origin: "http://localhost", "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}
const invoke = req => api.POST(req, { params: Promise.resolve({ id: account.id }) });

describe("Codex logout all devices", () => {
  it("calls the website endpoint with the correct account and proxy, preserving the row and its configuration", async () => {
    const response = await invoke(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ logoutRequested: true, localUpdated: true });
    expect(mocks.fetch).toHaveBeenCalledWith("https://chatgpt.com/backend-api/accounts/logout_all", expect.objectContaining({
      method: "POST", redirect: "error", headers: expect.objectContaining({ Authorization: "Bearer secret-access", "ChatGPT-Account-ID": "workspace-selected" }),
    }), expect.objectContaining({ connectionProxyUrl: "http://proxy.invalid:8080", strictProxy: true, signal: expect.any(AbortSignal) }));
    const saved = await db.getProviderConnectionById(account.id);
    expect(saved).toMatchObject({ id: account.id, name: account.name, email: account.email, priority: account.priority,
      maxConcurrency: 2, exclusiveApiKeyIds: [key.id], isActive: false, testStatus: "logged_out",
      accessToken: null, refreshToken: null, idToken: null, expiresAt: null,
      providerSpecificData: { ...account.providerSpecificData, logoutResumeActive: true, loggedOutAt: expect.any(String) },
    });
    expect(await db.getProviderConnections()).toHaveLength(1);
  });

  it("retains the disabled state for a disabled account's later relogin", async () => {
    await db.updateProviderConnection(account.id, { isActive: false });
    await logout(account.id);
    expect((await db.getProviderConnectionById(account.id)).providerSpecificData.logoutResumeActive).toBe(false);
  });

  it("accepts an empty 204 success without leaking credentials", async () => {
    mocks.fetch.mockResolvedValue(new Response(null, { status: 204 }));
    const text = await (await invoke(request())).text();
    expect(JSON.parse(text)).toMatchObject({ logoutRequested: true });
    expect(text).not.toMatch(/secret-access|secret-refresh|secret-id/);
  });

  it.each([401, 403, 429, 500])("keeps the local account intact on an upstream %s", async status => {
    mocks.fetch.mockImplementation(async () => new Response("blocked", { status }));
    const response = await invoke(request());
    expect(response.status).toBe(status === 500 ? 502 : status);
    expect(await db.getProviderConnectionById(account.id)).toEqual(account);
    expect(await db.getProviderConnections()).toHaveLength(1);
    expect(await response.text()).not.toContain("secret-");
  });

  it.each(["<html>verification required</html>", '{"success":false}', '{"error":"rejected"}', "false"])("does not treat a misleading HTTP 200 as logout success", async body => {
    mocks.fetch.mockResolvedValue(new Response(body, { status: 200 }));
    expect((await invoke(request())).status).toBe(502);
    expect(await db.getProviderConnectionById(account.id)).toEqual(account);
  });

  it("does not automatically retry an uncertain network failure", async () => {
    mocks.fetch.mockRejectedValue(new Error("Timed out with secret-access"));
    const response = await invoke(request());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("secret-access");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(await db.getProviderConnectionById(account.id)).toEqual(account);
  });

  it("keeps the record intact and provides a safe error when refreshing credentials fails", async () => {
    mocks.refresh.mockRejectedValue(new Error("Revoked secret-refresh"));
    const response = await invoke(request());
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("secret-refresh");
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(await db.getProviderConnectionById(account.id)).toEqual(account);
  });

  it("refreshes an expired OAuth credential once after a 401", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValueOnce(new Response('{}', { status: 200 }));
    mocks.refresh.mockImplementation(async (connection, force) => ({ connection: force
      ? await db.updateProviderConnection(connection.id, { accessToken: "renewed-access", refreshToken: "renewed-refresh" }) : connection }));
    expect(await logout(account.id)).toMatchObject({ logoutRequested: true, localUpdated: true });
    expect(mocks.refresh.mock.calls.map(call => call[1])).toEqual([false, true]);
    expect(mocks.fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer renewed-access");
  });

  it("does not erase credentials from a newer login", async () => {
    mocks.fetch.mockImplementation(async () => {
      await db.updateProviderConnection(account.id, { accessToken: "new-login", refreshToken: "new-login-refresh" });
      return new Response('{}', { status: 200 });
    });
    expect(await logout(account.id)).toMatchObject({ logoutRequested: true, localUpdated: false, warning: expect.any(String) });
    expect(await db.getProviderConnectionById(account.id)).toMatchObject({ isActive: true, accessToken: "new-login" });
  });

  it("does not overwrite another account record", async () => {
    const other = await db.createProviderConnection({ provider: "codex", authType: "access_token", email: "other@example.com", accessToken: "other-access" });
    await logout(account.id);
    expect(await db.getProviderConnectionById(other.id)).toEqual(other);
    expect(await db.getProviderConnections()).toHaveLength(2);
  });

  it("does not try to refresh an access-token login that OpenAI rejected", async () => {
    await db.updateProviderConnection(account.id, { authType: "access_token", refreshToken: null });
    mocks.fetch.mockResolvedValue(new Response(null, { status: 401 }));
    expect((await invoke(request())).status).toBe(401);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect((await db.getProviderConnectionById(account.id)).accessToken).toBe("secret-access");
  });

  it("shares concurrent requests for one account instead of submitting logout twice", async () => {
    let complete;
    mocks.fetch.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const first = logout(account.id), second = logout(account.id);
    expect(first).toBe(second);
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    complete(new Response('{}', { status: 200 }));
    await expect(first).resolves.toMatchObject({ logoutRequested: true });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported, deleted, and logged-out accounts before contacting OpenAI", async () => {
    const other = await db.createProviderConnection({ provider: "claude", authType: "oauth", accessToken: "other" });
    await expect(logout(other.id)).rejects.toMatchObject({ status: 400 });
    await expect(logout("missing")).rejects.toMatchObject({ status: 404 });
    await db.updateProviderConnection(account.id, { accessToken: null });
    await expect(logout(account.id)).rejects.toMatchObject({ status: 400 });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([{}, { confirm: false }, { confirm: "true" }])("requires explicit confirmation", async body => {
    expect((await invoke(request(body))).status).toBe(400);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(["https://untrusted.invalid", "null", ""])("rejects an untrusted browser origin: %s", async origin => {
    expect((await invoke(request({ confirm: true }, { Origin: origin }))).status).toBe(403);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("rejects form submissions and invalid JSON", async () => {
    expect((await invoke(request({ confirm: true }, { "Content-Type": "text/plain" }))).status).toBe(415);
    const invalid = new Request("http://localhost/api/providers/account/logout-all", { method: "POST",
      headers: { Origin: "http://localhost", "Content-Type": "application/json" }, body: "{" });
    expect((await invoke(invalid)).status).toBe(400);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

const device = (id, patch = {}) => ({ session_id: id, display_name: "Browser device", platform: "Linux",
  last_signed_in_timestamp_second: 1792620000, last_signed_in_city: "Shanghai", last_signed_in_country: "CN",
  app_sessions: [{ client_name: "ChatGPT" }], ...patch });
function respondDevices(devices) {
  mocks.fetch.mockImplementation(async () => Response.json({ show_session_manager: true, devices }));
}

describe("Codex live device list", () => {
  it("loads the actual account's devices using its proxy and returns only safe fields", async () => {
    respondDevices([device("private-session", { hashed_device_id: "private-hash", accessToken: "must-not-leak", is_current_device: true })]);
    const response = await sessionApi.GET(new Request("http://localhost/api/providers/account/sessions"), { params: Promise.resolve({ id: account.id }) });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ connectionId: account.id, source: "openai", verified: true, currentDeviceCount: 1,
      devices: [expect.objectContaining({ name: "Browser device", platform: "Linux", apps: ["ChatGPT"], status: "active", isCurrentSession: true })] });
    expect(body).not.toHaveProperty("snapshotAt");
    expect(body.devices[0]).not.toHaveProperty("firstObservedAt");
    expect(mocks.fetch.mock.calls[0]).toMatchObject([
      "https://chatgpt.com/backend-api/accounts/sessions?include_trusted_devices=true",
      { method: "GET", redirect: "error", headers: { "ChatGPT-Account-ID": "workspace-selected", Authorization: "Bearer secret-access" } },
      { strictProxy: true, connectionProxyUrl: "http://proxy.invalid:8080" },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/private-session|private-hash|must-not-leak|secret-access|secret-refresh/);
    expect(await db.getProviderConnectionById(account.id)).toEqual(account);
  });

  it("returns only the latest response after a new login", async () => {
    respondDevices([device("old-session")]);
    await sessions(account.id);
    await db.updateProviderConnection(account.id, { accessToken: "new-login" });
    respondDevices([device("new-session", { display_name: "New login" })]);
    const result = await sessions(account.id);
    expect(result).toMatchObject({ verified: true, currentDeviceCount: 1, devices: [{ name: "New login" }] });
    expect(result.devices).toHaveLength(1);
    expect(mocks.fetch.mock.calls.at(-1)[1].headers.Authorization).toBe("Bearer new-login");
  });

  it("returns no old devices on a Cloudflare challenge", async () => {
    respondDevices([device("session-one")]);
    await sessions(account.id);
    mocks.fetch.mockResolvedValue(new Response("<html>challenge</html>", { status: 403, headers: { "cf-mitigated": "challenge" } }));
    const result = await sessions(account.id);
    expect(result).toMatchObject({ verified: false, upstreamStatus: 403, errorCode: "browser_verification_required", devices: [] });
    expect(result).not.toHaveProperty("currentDeviceCount");
  });

  it.each([null, {}, { devices: [{}] }, { devices: [null] }, { show_session_manager: false, devices: [] }])("returns no previous devices for a malformed or unavailable list", async payload => {
    respondDevices([device("saved")]);
    await sessions(account.id);
    mocks.fetch.mockResolvedValue(Response.json(payload));
    const result = await sessions(account.id);
    expect(result.verified).toBe(false);
    expect(result.devices).toEqual([]);
    expect(result).not.toHaveProperty("snapshotAt");
  });

  it("distinguishes a verified empty response from a failed query", async () => {
    respondDevices([device("saved")]);
    await sessions(account.id);
    respondDevices([]);
    const empty = await sessions(account.id);
    expect(empty).toMatchObject({ verified: true, currentDeviceCount: 0, devices: [] });
    mocks.fetch.mockRejectedValue(new Error("Network failed"));
    const failed = await sessions(account.id);
    expect(failed.verified).toBe(false);
    expect(failed.devices).toEqual([]);
    expect(failed).not.toHaveProperty("currentDeviceCount");
  });

  it("does not return previous devices after logout cleared credentials", async () => {
    respondDevices([device("saved")]);
    await sessions(account.id);
    mocks.fetch.mockResolvedValue(new Response('{}', { status: 200 }));
    await logout(account.id);
    mocks.fetch.mockClear();
    const result = await sessions(account.id);
    expect(result).toMatchObject({ verified: false, errorCode: "not_logged_in", devices: [] });
    expect(result).not.toHaveProperty("lastLogoutAttempt");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("shows a rejected logout request without falsely marking devices signed out", async () => {
    respondDevices([device("saved")]);
    await sessions(account.id);
    mocks.fetch.mockResolvedValue(new Response(null, { status: 403 }));
    await expect(logout(account.id)).rejects.toMatchObject({ status: 403 });
    respondDevices([device("saved")]);
    const result = await sessions(account.id);
    expect(result.devices[0].status).toBe("active");
    expect((await db.getProviderConnectionById(account.id)).isActive).toBe(true);
  });

  it("uses each account's current credentials for its device list", async () => {
    respondDevices([device("account-one")]);
    await sessions(account.id);
    const other = await db.createProviderConnection({ provider: "codex", authType: "access_token", accessToken: "other" });
    respondDevices([device("account-two", { display_name: "Other account" })]);
    const result = await sessions(other.id);
    expect(result.devices).toHaveLength(1);
    expect(result.devices[0].name).toBe("Other account");
    expect(mocks.fetch.mock.calls.at(-1)[1].headers.Authorization).toBe("Bearer other");
  });

  it("ignores persisted device history and never writes a new snapshot", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const adapter = await getAdapter();
    const saved = JSON.stringify({ snapshotAt: "2026-10-22T01:00:00.000Z", devices: [{ id: "local-only", name: "Local history" }] });
    adapter.run("INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)", ["codexDeviceHistory", account.id, saved]);
    respondDevices([device("current", { display_name: "Live device" })]);
    expect((await sessions(account.id)).devices.map(item => item.name)).toEqual(["Live device"]);
    mocks.fetch.mockRejectedValue(new Error("Unavailable"));
    expect((await sessions(account.id)).devices).toEqual([]);
    expect(adapter.get("SELECT value FROM kv WHERE scope=? AND key=?", ["codexDeviceHistory", account.id]).value).toBe(saved);
  });

  it("shares in-flight queries but fetches again after completion", async () => {
    let complete;
    mocks.fetch.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const first = sessions(account.id), second = sessions(account.id);
    expect(first).toBe(second);
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    complete(Response.json({ devices: [device("first")] }));
    await first;
    respondDevices([device("second", { display_name: "Fresh response" })]);
    expect((await sessions(account.id)).devices.map(item => item.name)).toEqual(["Fresh response"]);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
});
