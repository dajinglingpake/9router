import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ target: vi.fn(), update: vi.fn(), settings: vi.fn(), launch: vi.fn(), proxy: vi.fn(),
  authorize: vi.fn(), startProxy: vi.fn(), register: vi.fn(), status: vi.fn(), clear: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.settings }));
vi.mock("@/lib/db/repos/connectionsRepo.js", () => ({ updateProviderConnection: mocks.update }));
vi.mock("@/lib/oauth/reloginCodex.js", () => ({ getCodexReloginTarget: mocks.target }));
vi.mock("@/lib/oauth/providers.js", () => ({ generateAuthData: mocks.authorize }));
vi.mock("@/lib/oauth/constants/oauth.js", () => ({ CODEX_CONFIG: { fixedPort: 1455, callbackPath: "/auth/callback" } }));
vi.mock("@/lib/oauth/utils/server.js", () => ({ startCodexProxy: mocks.startProxy, registerCodexSession: mocks.register, getCodexSessionStatus: mocks.status, clearCodexSession: mocks.clear }));
vi.mock("@/lib/accountAppeals/browser.mjs", () => ({ launchAppealBrowser: mocks.launch, VIEWPORT: { width: 1280, height: 900 } }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: mocks.proxy }));
vi.mock("@/lib/network/initOutboundProxy", () => ({ ensureOutboundProxyInitialized: vi.fn() }));

let api, browser, connection, raw, exitListeners, authStatus;
const owner = "owner";
const saved = id => globalThis.__nineRouterCodexBrowserLogin.sessions.get(id);
beforeEach(async () => {
  exitListeners = new Set(process.rawListeners("exit"));
  vi.resetModules(); vi.resetAllMocks();
  delete globalThis.__nineRouterCodexBrowserLogin;
  connection = { id: "account", provider: "codex", authType: "oauth", email: "owner@example.com", accessToken: "old-token",
    providerSpecificData: { chatgptAccountId: "workspace-1", proxyPoolId: "proxy" } };
  raw = JSON.stringify({ user: { email: connection.email, id: "user-1", amr: ["pwd"], mfa: true },
    account: { id: "workspace-1", planType: "pro", residencyRegion: "us" }, authProvider: "openai", expires: "2030-01-01T00:00:00Z",
    accessToken: "web-access", sessionToken: "web-session", statsigContext: { deviceId: "private-device" }, marketingEligibility: { keep: [true, false] }, futureField: "keep",
  }, null, 2);
  browser = { navigate: vi.fn().mockResolvedValue({}), evaluateMain: vi.fn().mockResolvedValue(raw), screenshot: vi.fn().mockResolvedValue("frame"),
    close: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue({}) };
  mocks.target.mockImplementation(async () => connection); mocks.update.mockResolvedValue(connection);
  mocks.settings.mockResolvedValue({}); mocks.proxy.mockResolvedValue({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.invalid" });
  mocks.launch.mockResolvedValue(browser);
  mocks.authorize.mockResolvedValue({ authUrl: "https://auth.openai.com/oauth/authorize", state: "oauth-state", codeVerifier: "private-verifier" });
  mocks.startProxy.mockResolvedValue({ success: true }); mocks.register.mockReturnValue(true);
  authStatus = { status: "pending" }; mocks.status.mockImplementation(() => authStatus);
  api = await import("@/lib/oauth/codexBrowserLogin");
});
afterEach(async () => {
  const state = globalThis.__nineRouterCodexBrowserLogin;
  if (state) {
    for (const session of [...state.sessions.values()]) await api.codexBrowserLoginAction(session.id, session.owner, { type: "close" });
    clearInterval(state.timer);
  }
  delete globalThis.__nineRouterCodexBrowserLogin;
  for (const listener of process.rawListeners("exit")) if (!exitListeners.has(listener)) process.removeListener("exit", listener);
  vi.unstubAllGlobals();
});
async function start({ create = false } = {}) {
  const { id } = await api.startCodexBrowserLogin(create ? undefined : connection.id, owner, "request-one", 20128);
  await saved(id).starting;
  return id;
}
async function tick(id) {
  saved(id).nextCheckAt = 0;
  await api.codexBrowserLoginFrame(id, owner);
  await saved(id).checking;
  return api.codexBrowserLoginFrame(id, owner, false);
}

describe("Codex relogin with automatic real Session recording", () => {
  it("also adds a new account and records its real Session through the same browser flow", async () => {
    const id = await start({ create: true });
    expect(mocks.target).not.toHaveBeenCalled();
    expect((await tick(id)).status).toBe("oauth");
    expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({ reloginConnectionId: null,
      expectedIdentity: { email: connection.email, accountId: "workspace-1" } }));
    authStatus = { status: "done", connectionId: "new-account" };
    mocks.target.mockResolvedValue({ ...connection, id: "new-account" });
    expect((await tick(id)).status).toBe("done");
    expect(mocks.update).toHaveBeenCalledWith("new-account", { chatgptSession: { raw, capturedAt: expect.any(String) } });
    expect(browser.close).toHaveBeenCalled();
  });

  it("records the complete response only after both website login and OAuth succeed", async () => {
    const id = await start();
    expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({ captureHelp: false, followPopups: true, allowLocalCallbacks: true, proxyUrl: "http://proxy.invalid" }));
    expect(browser.navigate).toHaveBeenCalledWith("https://chatgpt.com/");
    expect((await tick(id)).status).toBe("oauth");
    expect(mocks.authorize).toHaveBeenCalledWith("codex", "http://localhost:1455/auth/callback", { loginHint: connection.email });
    expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({ state: "oauth-state", reloginConnectionId: connection.id }));
    expect(mocks.update).not.toHaveBeenCalled();
    authStatus = { status: "done", connectionId: connection.id };
    const frame = await tick(id);
    expect(frame.status).toBe("done");
    expect(mocks.update).toHaveBeenCalledWith(connection.id, { chatgptSession: { raw, capturedAt: expect.any(String) } });
    expect(browser.close).toHaveBeenCalled();
    expect(JSON.stringify(frame)).not.toMatch(/web-session|web-access|private-verifier/);
  });

  it.each(["email", "workspace"])("waits for the original %s before starting OAuth", async field => {
    const value = JSON.parse(raw);
    if (field === "email") value.user.email = "other@example.com";
    else value.account.id = "other-workspace";
    browser.evaluateMain.mockResolvedValue(JSON.stringify(value));
    const frame = await tick(await start());
    expect(frame.status).toBe("web");
    expect(frame.message).toContain("不一致");
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does not record an anonymous session", async () => {
    browser.evaluateMain.mockResolvedValue("{}");
    expect((await tick(await start())).status).toBe("web");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it.each(["failed", "different account"])("keeps previous records intact on OAuth %s", async result => {
    const id = await start(); await tick(id);
    authStatus = result === "failed" ? { status: "error", error: "private-code" } : { status: "done", connectionId: "other-account" };
    const frame = await tick(id);
    expect(frame.status).toBe("error");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(JSON.stringify(frame)).not.toContain("private-code");
    expect(browser.close).toHaveBeenCalled();
  });

  it("finishes recording when the successful OAuth callback closes its browser", async () => {
    const id = await start(); await tick(id);
    authStatus = { status: "done", connectionId: connection.id };
    mocks.launch.mock.calls[0][0].onExit();
    expect((await tick(id)).status).toBe("done");
    expect(mocks.update).toHaveBeenCalled();
  });

  it("deduplicates starts and checks the window owner", async () => {
    const id = await start();
    expect(await api.startCodexBrowserLogin(connection.id, owner, "request-one", 20128)).toEqual({ id });
    expect(mocks.launch).toHaveBeenCalledTimes(1);
    await expect(api.codexBrowserLoginFrame(id, "other-owner")).rejects.toMatchObject({ status: 404 });
    await expect(api.codexBrowserLoginAction(id, "other-owner", { type: "close" })).rejects.toMatchObject({ status: 404 });
  });

  it("releases resources and does not save if closed while reading the website session", async () => {
    let resolve;
    browser.evaluateMain.mockImplementation(() => new Promise(done => { resolve = done; }));
    const id = await start();
    await api.codexBrowserLoginFrame(id, owner);
    const pending = saved(id).checking;
    await api.codexBrowserLoginAction(id, owner, { type: "close" });
    resolve(raw); await pending;
    expect(browser.close).toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it("also releases a browser that finishes launching after the window is closed", async () => {
    let resolve;
    mocks.launch.mockImplementation(() => new Promise(done => { resolve = done; }));
    const { id } = await api.startCodexBrowserLogin(connection.id, owner, "request-one", 20128);
    await vi.waitFor(() => expect(mocks.launch).toHaveBeenCalled());
    const closing = api.codexBrowserLoginAction(id, owner, { type: "close" });
    resolve(browser); await closing;
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browser.navigate).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("fails closed if the account's required proxy is unavailable", async () => {
    mocks.proxy.mockResolvedValue({ strictProxy: true });
    const id = await start();
    expect((await api.codexBrowserLoginFrame(id, owner)).status).toBe("error");
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("sends password input only to the browser and validates input coordinates", async () => {
    const id = await start();
    await api.codexBrowserLoginAction(id, owner, { type: "text", text: "private-password" });
    expect(browser.send).toHaveBeenCalledWith("Input.insertText", { text: "private-password" });
    expect(mocks.update).not.toHaveBeenCalled();
    await expect(api.codexBrowserLoginAction(id, owner, { type: "click", x: -1, y: 0 })).rejects.toMatchObject({ status: 400 });
  });

  it("reads the actual same-origin endpoint in the signed-in browser", async () => {
    vi.stubGlobal("location", { hostname: "chatgpt.com" });
    const fetch = vi.fn().mockResolvedValue(new Response(raw)); vi.stubGlobal("fetch", fetch);
    expect(await api.readChatgptSession()).toBe(raw);
    expect(fetch).toHaveBeenCalledWith("/api/auth/session", expect.objectContaining({ credentials: "include", cache: "no-store" }));
    location.hostname = "auth.openai.com";
    expect(await api.readChatgptSession()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
