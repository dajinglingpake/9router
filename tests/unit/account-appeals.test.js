import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connection: vi.fn(), settings: vi.fn(), refresh: vi.fn(), proxy: vi.fn(), fetch: vi.fn(), launch: vi.fn(), auth: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getProviderConnectionById: mocks.connection, getSettings: mocks.settings }));
vi.mock("@/lib/providerUsage", () => ({ refreshAndUpdateCredentials: mocks.refresh }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: mocks.proxy }));
vi.mock("@/lib/network/initOutboundProxy", () => ({ ensureOutboundProxyInitialized: vi.fn() }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
vi.mock("@/lib/accountAppeals/browser.mjs", () => ({ launchAppealBrowser: mocks.launch, VIEWPORT: { width: 1280, height: 900 } }));
vi.mock("@/lib/auth/dashboardSession", () => ({ verifyDashboardAuthToken: mocks.auth }));

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
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ user_id: "user-one", email: connection.email, name: "One" }) });
  mocks.launch.mockResolvedValue(browser);
  mocks.auth.mockImplementation(async token => token === "valid-dashboard-session");
  api = await import("@/lib/accountAppeals/sessions.js");
});

afterEach(async () => {
  const state = globalThis.__nineRouterAccountAppeals;
  clearInterval(state?.timer);
  if (state) for (const session of state.sessions.values()) await api.appealAction(session.id, session.owner, { type: "close" });
  delete globalThis.__nineRouterAccountAppeals;
  for (const listener of process.rawListeners("exit")) if (!exitListeners.has(listener)) process.removeListener("exit", listener);
});

async function start(requestId = "request-one", currentOwner = owner) {
  const result = await api.startAppeal(connection.id, currentOwner, requestId);
  await saved(result.id).starting;
  return result;
}

describe("isolated account appeals", () => {
  it("uses a disabled account through its configured proxy without returning credentials", async () => {
    const result = await start();
    expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({ proxyUrl: "http://proxy.test:8080" }));
    expect(mocks.fetch).toHaveBeenCalledWith("https://support.api.openai.com/api/v1/me", expect.objectContaining({ headers: { Authorization: "Bearer private-access" } }), expect.objectContaining({ strictProxy: true }));
    const frame = await api.appealFrame(result.id, owner);
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

  it("rejects a different identity before launching the browser", async () => {
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ user_id: "other", email: "other@example.com" }) });
    const { id } = await start();
    expect(saved(id).status).toBe("error");
    expect(saved(id).user).toBeNull();
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("keeps strict proxy failures from falling back to a direct browser connection", async () => {
    mocks.proxy.mockResolvedValue({ strictProxy: true, connectionProxyEnabled: false });
    const { id } = await start();
    expect(saved(id).status).toBe("error");
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
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
  const request = (token, origin = "http://router.test", host = "router.test", contentType = "application/json") => ({ cookies: { get: () => token ? { value: token } : undefined }, headers: new Headers({ ...(origin ? { origin } : {}), host, "content-type": contentType }) });
  it("always requires a valid dashboard login", async () => {
    const { appealOwner } = await import("@/lib/accountAppeals/request.js");
    await expect(appealOwner(request(null))).rejects.toMatchObject({ status: 401 });
    await expect(appealOwner(request("invalid"))).rejects.toMatchObject({ status: 401 });
    expect(await appealOwner(request("valid-dashboard-session"))).toBe(api.ownerFor("valid-dashboard-session"));
  });
  it.each([["http://other.test", "application/json", 403], [null, "application/json", 403], ["http://router.test", "text/plain", 415]])("rejects cross-site or non-JSON mutations", async (origin, contentType, status) => {
    const { appealOwner } = await import("@/lib/accountAppeals/request.js");
    await expect(appealOwner(request("valid-dashboard-session", origin, "router.test", contentType), true)).rejects.toMatchObject({ status });
  });
});
