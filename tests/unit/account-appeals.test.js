import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connection: vi.fn(), settings: vi.fn(), refresh: vi.fn(), proxy: vi.fn(), launch: vi.fn(), auth: vi.fn(), saveHistory: vi.fn() }));
vi.mock("@/lib/accountAppeals/history", () => ({ saveAppealMessages: mocks.saveHistory }));
vi.mock("@/lib/localDb", () => ({ getProviderConnectionById: mocks.connection, getSettings: mocks.settings }));
vi.mock("@/lib/providerUsage", () => ({ refreshAndUpdateCredentials: mocks.refresh }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: mocks.proxy }));
vi.mock("@/lib/network/initOutboundProxy", () => ({ ensureOutboundProxyInitialized: vi.fn() }));
vi.mock("@/lib/accountAppeals/browser.mjs", () => ({ launchAppealBrowser: mocks.launch, VIEWPORT: { width: 1280, height: 900 } }));
vi.mock("@/lib/auth/dashboardSession", () => ({ verifyDashboardAuthToken: mocks.auth, shouldUseSecureCookie: request => request.headers.get("x-forwarded-proto") === "https" }));

let api, browser, connection, exitListeners;
const owner = "operator-one", otherOwner = "operator-two";
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const saved = id => globalThis.__nineRouterAccountAppeals.sessions.get(id);

beforeEach(async () => {
  exitListeners = new Set(process.rawListeners("exit"));
  vi.resetModules(); vi.resetAllMocks();
  delete globalThis.__nineRouterAccountAppeals;
  connection = { id: "account-one", provider: "codex", email: "one@example.com", isActive: false, accessToken: "private-access", refreshToken: "private-refresh" };
  browser = { close: vi.fn().mockResolvedValue(), navigate: vi.fn().mockResolvedValue(), screenshot: vi.fn().mockResolvedValue("frame"), authenticate: vi.fn().mockResolvedValue({ ready: true }), evaluate: vi.fn().mockResolvedValue(true), send: vi.fn().mockResolvedValue() };
  mocks.connection.mockResolvedValue(connection);
  mocks.settings.mockResolvedValue({});
  mocks.refresh.mockResolvedValue({ connection });
  mocks.proxy.mockResolvedValue({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.test:8080", strictProxy: true });
  mocks.launch.mockResolvedValue(browser);
  mocks.auth.mockImplementation(async token => token === "valid-dashboard-session");
  mocks.saveHistory.mockResolvedValue();
  api = await import("@/lib/accountAppeals/sessions.js");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  const state = globalThis.__nineRouterAccountAppeals;
  clearInterval(state?.timer);
  if (state) for (const session of state.sessions.values()) await api.appealAction(session.id, session.owner, { type: "close" });
  delete globalThis.__nineRouterAccountAppeals;
  for (const listener of process.rawListeners("exit")) if (!exitListeners.has(listener)) process.removeListener("exit", listener);
});

describe("Help Center readiness", () => {
  it.each(["UH OH. SOMETHING WENT WRONG.", "UH OH, SOMETHING WENT WRONG.", "糟糕，出现问题。"])("does not report an error page as ready: %s", async message => {
    const { applyHelpIdentity } = await vi.importActual("@/lib/accountAppeals/browser.mjs");
    vi.stubGlobal("location", { hostname: "help.openai.com" });
    vi.stubGlobal("window", { __nineRouterAppealAccount: "one@example.com" });
    vi.stubGlobal("document", { body: { innerText: message } });
    expect(await applyHelpIdentity({ email: "one@example.com" })).toHaveProperty("error");
  });
  it("waits for the support chat to mount before reporting ready", async () => {
    const { applyHelpIdentity } = await vi.importActual("@/lib/accountAppeals/browser.mjs");
    const chat = vi.fn().mockReturnValue(null);
    vi.stubGlobal("location", { hostname: "help.openai.com" });
    vi.stubGlobal("window", { __nineRouterAppealAccount: "one@example.com" });
    vi.stubGlobal("document", { body: { innerText: "OpenAI" }, querySelector: selector => selector === "openai-chatkit" ? chat() : null });
    expect(await applyHelpIdentity({ email: "one@example.com" })).toEqual({ ready: false });
    chat.mockReturnValue({});
    expect(await applyHelpIdentity({ email: "one@example.com" })).toEqual({ ready: true });
  });
  it.each([true, false])("verifies the official support identity before applying credentials (matching=%s)", async matching => {
    const { applyHelpIdentity } = await vi.importActual("@/lib/accountAppeals/browser.mjs");
    const override = vi.fn();
    const body = { innerText: "OpenAI", __reactFiberTest: { memoizedProps: { value: { setGlobalContextOverride: override } } } };
    vi.stubGlobal("location", { hostname: "help.openai.com" });
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", { body, querySelectorAll: () => [], querySelector: () => ({}) });
    vi.stubGlobal("localStorage", { removeItem: vi.fn() });
    vi.stubGlobal("sessionStorage", { removeItem: vi.fn() });
    const identity = { user_id: "user-one", email: matching ? "one@example.com" : "other@example.com", name: "One" };
    const fetchIdentity = vi.fn().mockResolvedValue({ ok: true, json: async () => identity });
    vi.stubGlobal("fetch", fetchIdentity);
    const result = await applyHelpIdentity({ email: "one@example.com", accessToken: "private-access" });
    expect(fetchIdentity).toHaveBeenCalledWith("https://support.api.openai.com/api/v1/me", expect.objectContaining({ headers: { Authorization: "Bearer private-access" } }));
    if (matching) {
      expect(result).toEqual({ ready: false });
      expect(override).toHaveBeenCalledWith({ user: { id: identity.user_id, email: identity.email, name: identity.name, accessToken: "private-access" } });
    } else {
      expect(result).toHaveProperty("error");
      expect(override).not.toHaveBeenCalled();
    }
  });
});

async function start(requestId = "request-one", currentOwner = owner) {
  const result = await api.startAppeal(connection.id, currentOwner, requestId);
  await saved(result.id).starting;
  return result;
}

describe("isolated account appeals", () => {
  it("flushes captured replies when closing without keeping the browser alive", async () => {
    const { id } = await start();
    const { onMessage } = mocks.launch.mock.calls[0][0];
    const message = { id: "msg-one", threadId: "thread-one", role: "support", text: "已记录您的反馈", complete: true };
    onMessage(message);
    const result = await api.appealAction(id, owner, { type: "close" });
    expect(mocks.saveHistory).toHaveBeenCalledWith(connection.id, [message]);
    expect(result.historySavedAt).toBeTruthy();
    expect(result.historyError).toBeNull();
    expect(browser.close).toHaveBeenCalled();
    expect(saved(id)).toBeUndefined();
  });

  it("reports storage failures instead of claiming the conversation was saved", async () => {
    mocks.saveHistory.mockRejectedValue(new Error("disk full"));
    const { id } = await start();
    mocks.launch.mock.calls[0][0].onMessage({ id: "m", threadId: "t", role: "user", text: "申诉" });
    const result = await api.appealAction(id, owner, { type: "close" });
    expect(result.historyError).toContain("保存失败");
    expect(result.historySavedAt).toBeNull();
    expect(browser.close).toHaveBeenCalled();
  });

  it("uses a disabled account through its configured proxy without returning credentials", async () => {
    const result = await start();
    expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({ proxyUrl: "http://proxy.test:8080" }));
    const frame = await api.appealFrame(result.id, owner);
    expect(browser.authenticate).toHaveBeenCalledWith({ email: connection.email, accessToken: "private-access" });
    expect(JSON.stringify({ result, frame })).not.toMatch(/private-access|private-refresh/);
    expect(browser.navigate).toHaveBeenCalledTimes(1);
  });

  it("deduplicates startup retries and reserves capacity while startup is pending", async () => {
    const first = await api.startAppeal(connection.id, owner, "retry-key");
    const retry = await api.startAppeal(connection.id, owner, "retry-key");
    expect(retry.id).toBe(first.id);
    await api.startAppeal(connection.id, otherOwner, "retry-key");
    await expect(api.startAppeal(connection.id, owner, "third")).rejects.toMatchObject({ status: 409 });
  });

  it("does not share frames or control between dashboard sessions", async () => {
    const { id } = await start();
    await expect(api.appealFrame(id, otherOwner)).rejects.toMatchObject({ status: 404 });
    await expect(api.appealAction(id, otherOwner, { type: "close" })).rejects.toMatchObject({ status: 404 });
    expect(browser.close).not.toHaveBeenCalled();
  });

  it("requires a known account email before launching the browser", async () => {
    connection.email = null;
    const { id } = await start();
    expect(saved(id).status).toBe("error");
    expect(saved(id).user).toBeNull();
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("closes the isolated browser when its support identity does not match", async () => {
    browser.authenticate.mockResolvedValue({ error: "客服身份与所选账号不一致，已停止登录。" });
    const { id } = await start();
    await api.appealFrame(id, owner);
    await vi.waitFor(() => expect(saved(id).status).toBe("error"));
    expect(browser.close).toHaveBeenCalled();
    expect(saved(id).user).toBeNull();
  });

  it("keeps the browser open and backs off when the support service temporarily fails", async () => {
    browser.authenticate.mockResolvedValueOnce({ error: "客服身份验证失败（HTTP 500）", retryable: true }).mockResolvedValue({ ready: true });
    const { id } = await start();
    await api.appealFrame(id, owner);
    await vi.waitFor(() => expect(saved(id).authFailures).toBe(1));
    expect(saved(id).nextAuthAt).toBeGreaterThan(Date.now());
    await api.appealFrame(id, owner);
    expect(browser.authenticate).toHaveBeenCalledTimes(1);
    expect(browser.close).not.toHaveBeenCalled();
    saved(id).nextAuthAt = 0;
    await api.appealFrame(id, owner);
    await vi.waitFor(() => expect(saved(id).status).toBe("ready"));
    expect(saved(id).authFailures).toBe(0);
  });

  it("limits retries and releases resources after repeated support service failures", async () => {
    browser.authenticate.mockResolvedValue({ error: "客服身份验证失败（HTTP 500）", retryable: true });
    const { id } = await start();
    for (let attempt = 0; attempt < 3; attempt++) {
      saved(id).nextAuthAt = 0;
      await api.appealFrame(id, owner);
      await vi.waitFor(() => expect(saved(id).authenticating).toBe(false));
    }
    expect(browser.authenticate).toHaveBeenCalledTimes(3);
    expect(saved(id).status).toBe("error");
    expect(saved(id).user).toBeNull();
    expect(browser.close).toHaveBeenCalled();
  });

  it("keeps strict proxy failures from falling back to a direct browser connection", async () => {
    mocks.proxy.mockResolvedValue({ strictProxy: true, connectionProxyEnabled: false });
    const { id } = await start();
    expect(saved(id).status).toBe("error");
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("releases a browser that finishes launching after its window was closed", async () => {
    const pending = deferred();
    mocks.launch.mockReturnValue(pending.promise);
    const { id } = await api.startAppeal(connection.id, owner, "slow-start");
    await vi.waitFor(() => expect(mocks.launch).toHaveBeenCalled());
    const closing = api.appealAction(id, owner, { type: "close" });
    pending.resolve(browser);
    await closing;
    expect(browser.close).toHaveBeenCalled();
    expect(browser.navigate).not.toHaveBeenCalled();
    expect(saved(id)).toBeUndefined();
  });

  it("fills the composer without sending a message or pressing Enter", async () => {
    const { id } = await start();
    await api.appealFrame(id, owner);
    await vi.waitFor(() => expect(saved(id).status).toBe("ready"));
    await api.appealAction(id, owner, { type: "text", text: "我的申诉内容" });
    expect(browser.send).toHaveBeenLastCalledWith("Input.insertText", { text: "我的申诉内容" });
    expect(browser.send.mock.calls.some(([method, input]) => method === "Input.dispatchKeyEvent" && input.key === "Enter")).toBe(false);
    expect(browser.evaluate.mock.calls[0][0]).not.toContain("sendUserMessage");
  });

  it("heartbeats without capturing frames when the viewer is hidden", async () => {
    const { id } = await start();
    const frame = await api.appealFrame(id, owner, false);
    expect(frame.image).toBeUndefined();
    expect(browser.screenshot).not.toHaveBeenCalled();
  });

  it("closes and removes credentials when a session ends", async () => {
    const { id } = await start();
    const session = saved(id);
    await api.appealAction(id, owner, { type: "close" });
    expect(browser.close).toHaveBeenCalled();
    expect(session.user).toBeNull();
    await expect(api.appealFrame(id, owner)).rejects.toMatchObject({ status: 404 });
  });

  it("expires disconnected or idle viewers independently of ongoing frame polling", () => {
    const now = 2_000_000;
    expect(api.shouldExpire({ lastSeen: now, lastInput: now - api.IDLE_MS - 1 }, now)).toBe(true);
    expect(api.shouldExpire({ lastSeen: now - api.DISCONNECTED_MS - 1, lastInput: now }, now)).toBe(true);
    expect(api.shouldExpire({ lastSeen: now - 10_000, lastInput: now - 60_000 }, now)).toBe(false);
  });

  it.each([{ type: "evaluate", expression: "process.env" }, { type: "navigate", url: "http://localhost/" }, { type: "click", x: -1, y: 0 }, { type: "click", x: 0, y: 900 }, { type: "text", text: "x".repeat(20001) }, { type: "key", key: "F12" }])("rejects unsupported browser controls: $type", action => {
    expect(() => api.validateAppealAction(action)).toThrow();
  });
});

describe("appeal request authorization", () => {
  const request = (token, origin = "http://router.test", host = "router.test", contentType = "application/json", guest) => ({ cookies: { get: name => { const value = name === "auth_token" ? token : guest; return value ? { value } : undefined; } }, headers: new Headers({ ...(origin ? { origin } : {}), host, "content-type": contentType }) });
  it("requires a valid dashboard login when login is enabled", async () => {
    const { appealOwner } = await import("@/lib/accountAppeals/request.js");
    await expect(appealOwner(request(null))).rejects.toMatchObject({ status: 401 });
    await expect(appealOwner(request("invalid"))).rejects.toMatchObject({ status: 401 });
    expect(await appealOwner(request("valid-dashboard-session"))).toEqual({ owner: api.ownerFor("valid-dashboard-session") });
  });
  it("isolates visitors in configured no-login mode using a private session cookie", async () => {
    mocks.settings.mockResolvedValue({ requireLogin: false });
    const { appealOwner, appealResponse } = await import("@/lib/accountAppeals/request.js");
    const first = await appealOwner(request(null), true, true);
    const second = await appealOwner(request(null), true, true);
    expect(first.owner).not.toBe(second.owner);
    expect(first.cookie).toMatch(/; Path=\/api\/account-appeals; HttpOnly; SameSite=Strict$/);
    const cookie = first.cookie.split(";")[0].split("=")[1];
    const existing = request(null, undefined, undefined, undefined, cookie);
    expect(await appealOwner(existing)).toEqual({ owner: first.owner });
    expect(appealResponse({}, 202, first.cookie).headers.get("set-cookie")).toBe(first.cookie);
    await expect(appealOwner(request(null))).rejects.toMatchObject({ status: 401 });
    await expect(appealOwner(request(null), true)).rejects.toMatchObject({ status: 401 });
    mocks.settings.mockResolvedValue({ requireLogin: true });
    await expect(appealOwner(existing)).rejects.toMatchObject({ status: 401 });
  });
  it("uses a secure visitor cookie for HTTPS", async () => {
    mocks.settings.mockResolvedValue({ requireLogin: false });
    const { appealOwner } = await import("@/lib/accountAppeals/request.js");
    const secure = request(null);
    secure.headers.set("x-forwarded-proto", "https");
    expect((await appealOwner(secure, true, true)).cookie).toContain("; Secure");
  });
  it.each([["http://other.test", "application/json", 403], [null, "application/json", 403], ["http://router.test", "text/plain", 415]])("rejects cross-site or non-JSON mutations", async (origin, contentType, status) => {
    const { appealOwner } = await import("@/lib/accountAppeals/request.js");
    await expect(appealOwner(request("valid-dashboard-session", origin, "router.test", contentType), true)).rejects.toMatchObject({ status });
  });
});
