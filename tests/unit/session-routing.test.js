import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zstdCompressSync } from "node:zlib";

const state = vi.hoisted(() => ({
  bindings: new Map(),
  connections: [],
  handleChatCore: vi.fn(),
  checkAndRefreshToken: vi.fn(),
  comboModels: null,
  accountModels: {},
}));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/db/helpers/metaStore.js", () => ({
  getMeta: async (key) => state.bindings.get(key) ?? null,
  setMeta: async (key, value) => { state.bindings.set(key, value); },
  deleteMeta: async (key) => { state.bindings.delete(key); },
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false, fallbackStrategy: "round-robin" }),
  getProviderConnections: async (filter = {}) => state.connections.filter((c) => filter.isActive === undefined || c.isActive === filter.isActive),
  getProviderConnectionById: async (id) => state.connections.find((c) => c.id === id),
  updateProviderConnection: async (id, patch) => Object.assign(state.connections.find((c) => c.id === id), patch),
  getApiKeyByValue: async () => null,
  getProxyPools: async () => [],
  validateApiKey: async () => true,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: async () => ({}), pickProxyPoolId: vi.fn(),
}));
vi.mock("@/lib/usageDb.js", () => ({ appendRequestLog: vi.fn().mockResolvedValue() }));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: async (model) => model === "combo" ? {} : { provider: model.startsWith("cc/") ? "claude-code" : "codex", model: model.endsWith("other-model") ? "other-model" : "test-model" },
  getComboAccountModels: async (names) => names.length ? state.accountModels : {},
  getComboModels: async (model) => ["combo", "cc/combo"].includes(model) ? state.comboModels : null,
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: state.checkAndRefreshToken, updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: state.handleChatCore }));
vi.mock("../../src/sse/utils/logger.js", () => ({
  info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), maskKey: () => "masked",
}));

import { getSessionRoutingKey, getSessionBinding } from "../../src/sse/services/sessionRouting.js";
import { getProviderCredentials, clearAccountError } from "../../src/sse/services/auth.js";
import { handleChat } from "../../src/sse/handlers/chat.js";
import { appendRequestLog } from "@/lib/usageDb.js";
import { getModelRequestStats } from "../../src/lib/runtimeModelStats.js";
import { getConcurrencySnapshot, acquireConcurrencySlot, pauseAccountQueue, resumeAccountQueue, __test__ as concurrencyTest } from "../../src/sse/services/concurrencyLimiter.js";

afterEach(() => {
  concurrencyTest.reset();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  globalThis._runtimeModelStats.groups.clear();
  globalThis._runtimeModelStats.requests = new WeakMap();
  vi.clearAllMocks();
  state.bindings.clear();
  state.comboModels = null;
  state.accountModels = {};
  state.connections = [
    { id: "a", provider: "codex", name: "A", priority: 1, isActive: true, maxConcurrency: 1 },
    { id: "b", provider: "codex", name: "B", priority: 2, isActive: true, maxConcurrency: 1 },
  ];
  state.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
  state.handleChatCore.mockImplementation(async () => ({ success: true, response: new Response("ok") }));
});

const request = (sessionId, model = "codex/test-model", signal) => new Request("http://localhost/v1/responses", {
  method: "POST", headers: sessionId ? { "x-session-id": sessionId } : {},
  body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }] }), signal,
});
const successfulStream = () => ({ success: true, response: new Response("ok") });

describe("strict session account routing", () => {
  it.each([false, true])("uses account-specific models while other accounts inherit the common combo (zstd=%s)", async compressed => {
    const accountRequest = async (sessionId, model) => {
      const plain = request(sessionId, model);
      if (!compressed) return plain;
      return new Request(plain.url, {
        method: "POST",
        headers: { ...Object.fromEntries(plain.headers), "content-encoding": "zstd" },
        body: zstdCompressSync(await plain.text()),
      });
    };
    state.comboModels = ["codex/test-model"];
    state.accountModels = { a: "lower-model" };
    const first = await handleChat(await accountRequest("custom-a", "cc/combo"));
    await first.text();
    const busy = await acquireConcurrencySlot({ scope: "account", id: "a", limit: 1 });
    const second = await handleChat(await accountRequest("common-b", "combo"));
    expect(state.handleChatCore.mock.calls.map(([args]) => [args.connectionId, args.modelInfo.model]))
      .toEqual([["a", "lower-model"], ["b", "test-model"]]);
    expect(state.handleChatCore.mock.calls[0][0].body.model).toBe("codex/lower-model");
    await second.text();
    busy.release();
    state.accountModels.a = "another-lower-model";
    await (await handleChat(await accountRequest("custom-a", "cc/combo"))).text();
    expect(state.handleChatCore.mock.lastCall[0]).toMatchObject({ connectionId: "a", modelInfo: { model: "another-lower-model" } });
    state.accountModels = {};
    await (await handleChat(await accountRequest("custom-a", "cc/combo"))).text();
    expect(state.handleChatCore.mock.lastCall[0]).toMatchObject({ connectionId: "a", modelInfo: { model: "test-model" } });
  });

  it("checks model locks against the customized model before selecting the account", async () => {
    state.comboModels = ["codex/test-model"];
    state.accountModels = { a: "lower-model" };
    state.connections[0]["modelLock_test-model"] = new Date(Date.now() + 60000).toISOString();
    await (await handleChat(request("custom-lock", "combo"))).text();
    expect(state.handleChatCore.mock.lastCall[0]).toMatchObject({ connectionId: "a", modelInfo: { model: "lower-model" } });
    state.connections[0]["modelLock_lower-model"] = new Date(Date.now() + 60000).toISOString();
    const response = await handleChat(request("custom-lock", "combo"));
    expect(response.status).toBe(503);
    expect(state.handleChatCore).toHaveBeenCalledTimes(1);
  });

  it("keeps the customized model and pinned account across account-wide overload cooldown", async () => {
    vi.useFakeTimers();
    state.comboModels = ["codex/test-model"];
    state.accountModels = { a: "lower-model" };
    state.handleChatCore.mockResolvedValueOnce({ success: false, status: 503, error: "overloaded", response: new Response("overloaded", { status: 503 }) });
    const pending = handleChat(request("custom-retry", "combo"));
    await vi.waitFor(() => expect(getConcurrencySnapshot().find(p => p.id === "a")?.queued).toBe(1));
    const newSession = await handleChat(request("new-while-cooling", "combo"));
    expect(state.handleChatCore.mock.lastCall[0]).toMatchObject({ connectionId: "b", modelInfo: { model: "test-model" } });
    await newSession.text();
    await vi.advanceTimersByTimeAsync(30000);
    await (await pending).text();
    expect(state.handleChatCore.mock.lastCall[0]).toMatchObject({ connectionId: "a", retryCount: 1, modelInfo: { model: "lower-model" } });
    expect(getModelRequestStats().find(g => g.connectionId === "a").model).toBe("lower-model");
  });

  it("counts a request once across account cooldown and internal retries", async () => {
    vi.useFakeTimers();
    state.handleChatCore
      .mockImplementationOnce(async ({ onUpstreamOverload }) => {
        onUpstreamOverload();
        onUpstreamOverload();
        return { success: false, status: 503, error: "overloaded", response: new Response("overloaded", { status: 503 }) };
      })
      .mockImplementationOnce(async ({ onRequestComplete }) => {
        onRequestComplete();
        return successfulStream();
      });
    const pending = handleChat(request("stats-retry"));
    await vi.waitFor(() => expect(getConcurrencySnapshot().find(p => p.id === "a")?.queued).toBe(1));
    expect(getModelRequestStats()).toEqual([{ connectionId: "a", provider: "codex", model: "test-model", requests: 1, overloaded: 1, recovered: 0 }]);
    await vi.advanceTimersByTimeAsync(30000);
    const response = await pending;
    await response.text();
    expect(getModelRequestStats()).toEqual([{ connectionId: "a", provider: "codex", model: "test-model", requests: 1, overloaded: 1, recovered: 1 }]);
  });
  it("restarts the whole account cooldown and releases only one recovery request", async () => {
    vi.useFakeTimers();
    pauseAccountQueue("a", Date.now() + 30000);
    const first = acquireConcurrencySlot({ scope: "account", id: "a", limit: 4 });
    let secondReady = false;
    const second = acquireConcurrencySlot({ scope: "account", id: "a", limit: 4 }).then(p => { secondReady = true; return p; });
    await vi.advanceTimersByTimeAsync(20000);
    pauseAccountQueue("a", Date.now() + 30000);
    await vi.advanceTimersByTimeAsync(10000);
    expect(getConcurrencySnapshot()[0]).toMatchObject({ active: 0, queued: 2, state: "cooldown", cooldownRemainingMs: 20000 });
    expect(getConcurrencySnapshot()[0].queue[0]).toMatchObject({ state: "cooldown", cooldownRemainingMs: 20000, timeoutRemainingMs: 270000 });
    await vi.advanceTimersByTimeAsync(20000);
    const permit = await first;
    expect(secondReady).toBe(false);
    expect(getConcurrencySnapshot()[0]).toMatchObject({ active: 1, queued: 1, state: "recovering" });
    resumeAccountQueue("a");
    (await second).release();
    permit.release();
  });

  it("returns 503 only after five minutes of repeated overload without resetting the deadline", async () => {
    vi.useFakeTimers();
    vi.stubEnv("CONCURRENCY_QUEUE_TIMEOUT_MS", "300000");
    state.handleChatCore.mockImplementation(async () => ({ success: false, status: 503, error: "overloaded", response: new Response("overloaded", { status: 503 }) }));
    const pending = handleChat(request("keeps-waiting"));
    await vi.waitFor(() => expect(getConcurrencySnapshot().find(p => p.id === "a")?.queued).toBe(1));
    await vi.advanceTimersByTimeAsync(300000);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.text()).toMatch(/timed out|超时/);
    expect(state.handleChatCore).toHaveBeenCalledTimes(10);
    expect(appendRequestLog).toHaveBeenCalledWith(expect.objectContaining({
      source: "router", status: "FAILED 503", connectionId: "a",
      retryCount: 10, timeoutRemainingMs: 0,
    }));
    expect(state.handleChatCore.mock.calls.map(([args]) => args.retryCount)).toEqual(Array.from({ length: 10 }, (_, i) => i));
    expect(state.handleChatCore.mock.calls[1][0].diagnosticContext).toMatchObject({
      connectionId: "a", retryCount: 1, active: 1, queued: 0, limit: 1, accountState: "recovering",
    });
    expect(state.handleChatCore.mock.calls[1][0].diagnosticContext.requestId).toBe(state.handleChatCore.mock.calls[0][0].diagnosticContext.requestId);
    expect(state.handleChatCore.mock.calls.every(([args]) => args.connectionId === "a")).toBe(true);
    expect(getConcurrencySnapshot().every(p => p.queued === 0)).toBe(true);
  });

  it("cancels a request waiting for account cooldown without switching accounts", async () => {
    state.handleChatCore.mockResolvedValueOnce({ success: false, status: 503, error: "overloaded", response: new Response("overloaded", { status: 503 }) });
    const controller = new AbortController();
    const pending = handleChat(request("cancel-cooldown", "codex/test-model", controller.signal));
    await vi.waitFor(() => expect(getConcurrencySnapshot().find(p => p.id === "a")?.queued).toBe(1));
    controller.abort();
    expect((await pending).status).toBe(499);
    expect(state.handleChatCore).toHaveBeenCalledTimes(1);
    expect(getConcurrencySnapshot().every(p => p.queued === 0)).toBe(true);
  });

  it("returns 503 when the shared deadline expires during an upstream attempt", async () => {
    vi.useFakeTimers();
    vi.stubEnv("CONCURRENCY_QUEUE_TIMEOUT_MS", "300000");
    state.handleChatCore.mockImplementation(({ clientAbortSignal }) => new Promise(resolve => {
      clientAbortSignal.addEventListener("abort", () => resolve({ success: false, status: 499, response: new Response("aborted", { status: 499 }) }), { once: true });
    }));
    const pending = handleChat(request("stalled"));
    await vi.waitFor(() => expect(state.handleChatCore).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(300000);
    expect((await pending).status).toBe(503);
    expect(getConcurrencySnapshot()).toEqual([]);
  });
  it("resolves cc combo names before provider prefixes for existing conversations", async () => {
    state.comboModels = ["codex/test-model"];
    const key = getSessionRoutingKey({ "x-session-id": "existing" }, {}, null);
    state.bindings.set(`chat-session:${key}`, JSON.stringify({ provider: "codex", connectionId: "b" }));
    const response = await handleChat(request("existing", "cc/combo"));
    expect(response.status).toBe(200);
    await response.text();
    expect(state.handleChatCore.mock.calls[0][0].connectionId).toBe("b");
    expect(state.handleChatCore.mock.calls[0][0].modelInfo.provider).toBe("codex");
  });
  it("ignores per-request IDs, isolates callers, and recognizes Claude/Codex sessions", () => {
    expect(getSessionRoutingKey({ "x-client-request-id": "one-request" }, {}, "caller")).toBeNull();
    const key = getSessionRoutingKey({ "session_id": "conversation" }, {}, "caller");
    expect(key).toBe(getSessionRoutingKey({ "session_id": "conversation", "x-client-request-id": "changed" }, { messages: ["changed"] }, "caller"));
    expect(key).not.toBe(getSessionRoutingKey({ "session_id": "conversation" }, {}, "other-caller"));
    expect(getSessionRoutingKey({}, { conversation_id: "one", prompt_cache_key: "shared-cache" }, "caller"))
      .not.toBe(getSessionRoutingKey({}, { conversation_id: "two", prompt_cache_key: "shared-cache" }, "caller"));
    expect(getSessionRoutingKey({}, { metadata: { user_id: '{"session_id":"abc"}' } }, "caller"))
      .toBe(getSessionRoutingKey({ "x-claude-code-session-id": "abc" }, {}, "caller"));
  });

  it("fills the first account, then overflows new sessions, including concurrent selection", async () => {
    state.connections[0].maxConcurrency = 4;
    const selections = await Promise.all(Array.from({ length: 5 }, (_, i) => getProviderCredentials("codex", null, "test-model", { sessionKey: `s${i}` })));
    expect(selections.map((c) => c.connectionId)).toEqual(["a", "a", "a", "a", "b"]);
    selections.forEach((c) => c.releaseSelection());
    const bound = await getProviderCredentials("codex", null, "test-model", { sessionKey: "s4" });
    expect(bound.connectionId).toBe("b");
    bound.releaseSelection();
  });

  it("serializes competing first requests for the same session and keeps the stored binding", async () => {
    const selected = await Promise.all([1, 2].map(() => getProviderCredentials("codex", null, "test-model", { sessionKey: "same" })));
    expect(selected.map((c) => c.connectionId)).toEqual(["a", "a"]);
    selected.forEach((c) => c.releaseSelection());
    expect(await getSessionBinding("same")).toEqual({ provider: "codex", connectionId: "a" });
    state.connections.reverse();
    const again = await getProviderCredentials("codex", null, "test-model", { sessionKey: "same" });
    expect(again.connectionId).toBe("a");
    again.releaseSelection();
  });

  it("keeps a disabled binding but rebinds when its connection is removed", async () => {
    state.bindings.set("chat-session:restored", JSON.stringify({ provider: "codex", connectionId: "b" }));
    const restored = await getProviderCredentials("codex", null, "test-model", { sessionKey: "restored" });
    expect(restored.connectionId).toBe("b");
    restored.releaseSelection();
    state.connections[1].isActive = false;
    const disabled = await getProviderCredentials("codex", null, "test-model", { sessionKey: "restored" });
    expect(disabled).toMatchObject({ sessionUnavailable: true });
    expect(await getSessionBinding("restored")).toEqual({ provider: "codex", connectionId: "b" });

    state.connections = state.connections.filter((connection) => connection.id !== "b");
    const rebound = await getProviderCredentials("codex", null, "test-model", { sessionKey: "restored" });
    expect(rebound.connectionId).toBe("a");
    rebound.releaseSelection();
    expect(await getSessionBinding("restored")).toEqual({ provider: "codex", connectionId: "a" });
    expect(await getProviderCredentials("other", null, "test-model", { sessionKey: "restored" })).toMatchObject({ sessionUnavailable: true, lastErrorCode: 409 });
  });

  it("keeps the binding when the account is temporarily model-locked", async () => {
    state.bindings.set("chat-session:cooldown", JSON.stringify({ provider: "codex", connectionId: "b" }));
    state.connections[1]["modelLock_test-model"] = new Date(Date.now() + 60000).toISOString();
    state.connections[1].errorCode = 429;

    const unavailable = await getProviderCredentials("codex", null, "test-model", { sessionKey: "cooldown" });

    expect(unavailable).toMatchObject({ sessionUnavailable: true });
    expect(await getSessionBinding("cooldown")).toEqual({ provider: "codex", connectionId: "b" });
  });

  it("queues an existing session on its bound account even when the other account is free", async () => {
    let finish;
    state.handleChatCore.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = handleChat(request("same"));
    await vi.waitFor(() => expect(state.handleChatCore).toHaveBeenCalledTimes(1));
    const second = handleChat(request("same"));
    await vi.waitFor(() => expect(getConcurrencySnapshot().find((p) => p.id === "a")?.queued).toBe(1));
    expect(state.handleChatCore).toHaveBeenCalledTimes(1);
    finish(successfulStream());
    await (await first).text();
    await (await second).text();
    expect(state.handleChatCore.mock.calls.map(([args]) => args.connectionId)).toEqual(["a", "a"]);
  });

  it("cools all models on an overloaded account for 30 seconds without moving existing sessions", async () => {
    vi.useFakeTimers();
    const staleCredentials = { ...state.connections[0] };
    state.connections[0]["modelLock_other-model"] = new Date(Date.now() - 1000).toISOString();
    state.handleChatCore.mockImplementation(async ({ onRequestSuccess }) => {
      await onRequestSuccess();
      return { success: true, response: new Response("ok") };
    });
    state.handleChatCore.mockResolvedValueOnce({ success: false, status: 503, error: "Our servers are currently overloaded", response: new Response("overloaded", { status: 503 }) });
    const pending = handleChat(request("overloaded-old"));
    await vi.waitFor(() => expect(getConcurrencySnapshot().find(p => p.id === "a")?.queued).toBe(1));
    expect(getConcurrencySnapshot().find(p => p.id === "a").queue[0].retryCount).toBe(1);
    const remaining = new Date(state.connections[0].modelLock___all).getTime() - Date.now();
    expect(remaining).toBeGreaterThan(29000);
    expect(remaining).toBeLessThanOrEqual(30000);
    // A success from a request already in flight cannot clear the new cooldown.
    await clearAccountError("a", staleCredentials, "test-model");
    expect(state.connections[0].errorCode).toBe(503);
    expect(state.connections[0].modelLock___all).toBeTruthy();
    const blocked = handleChat(request("overloaded-old", "codex/other-model"));
    await vi.waitFor(() => expect(getConcurrencySnapshot().find(p => p.id === "a")?.queued).toBe(2));
    expect(state.handleChatCore).toHaveBeenCalledTimes(1);
    await (await handleChat(request("overloaded-new", "codex/other-model"))).text();
    expect(state.handleChatCore.mock.calls[1][0].connectionId).toBe("b");
    await vi.advanceTimersByTimeAsync(30000);
    expect((await pending).status).toBe(200);
    expect((await blocked).status).toBe(200);
    expect(state.handleChatCore.mock.calls[2][0].connectionId).toBe("a");
    expect(state.connections[0]).toMatchObject({ modelLock___all: null, testStatus: "active", errorCode: null });
    expect(state.handleChatCore.mock.calls[3][0]).toMatchObject({ connectionId: "a", modelInfo: { model: "other-model" } });
  });

  it("returns a quota error without fallback; old sessions stay blocked and new sessions use B", async () => {
    state.handleChatCore.mockResolvedValueOnce({ success: false, status: 429, error: "quota exceeded", response: new Response("quota exceeded", { status: 429, headers: { "Retry-After": "60" } }) });
    const failed = await handleChat(request("old"));
    expect(failed.status).toBe(429);
    expect(failed.headers.get("retry-after")).toBe("60");
    expect(await failed.text()).toContain("请开启新会话");
    expect(state.handleChatCore).toHaveBeenCalledTimes(1);
    const again = await handleChat(request("old"));
    expect(again.status).toBe(429);
    expect(state.handleChatCore).toHaveBeenCalledTimes(1);
    await (await handleChat(request("new"))).text();
    expect(state.handleChatCore.mock.calls[1][0].connectionId).toBe("b");
  });

  it("returns the account error to requests already waiting in its queue", async () => {
    let finish;
    state.handleChatCore.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = handleChat(request("queued-failure"));
    await vi.waitFor(() => expect(state.handleChatCore).toHaveBeenCalledTimes(1));
    const queued = handleChat(request("queued-failure"));
    await vi.waitFor(() => expect(getConcurrencySnapshot().find((p) => p.id === "a")?.queued).toBe(1));
    finish({ success: false, status: 429, error: "quota exceeded", response: new Response("quota", { status: 429 }) });
    expect((await first).status).toBe(429);
    const response = await queued;
    expect(response.status).toBe(429);
    expect(await response.text()).toContain("请开启新会话");
    expect(state.handleChatCore).toHaveBeenCalledTimes(1);
    expect(getConcurrencySnapshot().filter((p) => p.scope === "account")).toEqual([]);
  });

  it("cancels a queued request without changing the session binding or locking the account", async () => {
    let finish;
    state.handleChatCore.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = handleChat(request("cancel-queue"));
    await vi.waitFor(() => expect(state.handleChatCore).toHaveBeenCalledTimes(1));
    const controller = new AbortController();
    const queued = handleChat(request("cancel-queue", "codex/test-model", controller.signal));
    await vi.waitFor(() => expect(getConcurrencySnapshot().find((p) => p.id === "a")?.queued).toBe(1));
    controller.abort();
    expect((await queued).status).toBe(499);
    expect(state.connections[0]["modelLock_test-model"]).toBeUndefined();
    finish(successfulStream());
    await (await first).text();
    await (await handleChat(request("cancel-queue"))).text();
    expect(state.handleChatCore.mock.calls.map(([args]) => args.connectionId)).toEqual(["a", "a"]);
  });

  it("does not switch models in a combo after failure", async () => {
    vi.stubEnv("CONCURRENCY_QUEUE_TIMEOUT_MS", "50");
    state.comboModels = ["codex/test-model", "another-provider/model"];
    state.handleChatCore.mockResolvedValueOnce({ success: false, status: 503, error: "overloaded", response: new Response("overloaded", { status: 503 }) });
    const response = await handleChat(request("combo-session", "combo"));
    expect(response.status).toBe(503);
    expect(state.handleChatCore).toHaveBeenCalledTimes(1);
  });

  it("accepts headerless requests and prefers the first account without creating bindings", async () => {
    await (await handleChat(request(null))).text();
    await (await handleChat(request(null))).text();
    expect(state.handleChatCore.mock.calls.map(([args]) => args.connectionId)).toEqual(["a", "a"]);
    expect(state.bindings.size).toBe(0);
  });

  it("uses B while A is full for headerless requests, then returns to A when it is free", async () => {
    let finish;
    state.handleChatCore.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = handleChat(request(null));
    await vi.waitFor(() => expect(state.handleChatCore).toHaveBeenCalledTimes(1));
    await (await handleChat(request(null))).text();
    finish(successfulStream());
    await (await first).text();
    await (await handleChat(request(null))).text();
    expect(state.handleChatCore.mock.calls.map(([args]) => args.connectionId)).toEqual(["a", "b", "a"]);
    expect(state.bindings.size).toBe(0);
  });

  it("retains account fallback for headerless requests", async () => {
    state.handleChatCore.mockResolvedValueOnce({ success: false, status: 429, error: "quota exceeded", response: new Response("quota", { status: 429 }) });
    const response = await handleChat(request(null));
    expect(response.status).toBe(200);
    await response.text();
    expect(state.handleChatCore.mock.calls.map(([args]) => args.connectionId)).toEqual(["a", "b"]);
    expect(state.bindings.size).toBe(0);
  });

  it("releases reservations after preparation fails", async () => {
    state.checkAndRefreshToken.mockRejectedValueOnce(new Error("refresh failed"));
    expect((await handleChat(request("failed"))).status).toBe(502);
    delete state.connections[0]["modelLock_test-model"];
    await (await handleChat(request("next"))).text();
    expect(state.handleChatCore.mock.calls[0][0].connectionId).toBe("a");
    expect(getConcurrencySnapshot().filter((p) => p.scope === "account")).toEqual([]);
  });
});
