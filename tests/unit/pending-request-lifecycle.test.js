import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { execute, appendRequestLog } = vi.hoisted(() => ({ execute: vi.fn(), appendRequestLog: vi.fn(async () => {}) }));
vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: async () => ({ all: () => [] }) }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => ({ noAuth: true, execute }) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest() {}, logRawRequest() {}, logTargetRequest() {},
    logProviderResponse() {}, logConvertedResponse() {}, logError() {},
  }),
}));
vi.mock("@/lib/usageDb.js", async () => {
  const { trackPendingRequest } = await import("../../src/lib/db/repos/usageRepo.js");
  return { trackPendingRequest, appendRequestLog, saveRequestDetail: async () => {}, saveRequestUsage: async () => {} };
});
import { trackPendingRequest, getActiveRequests } from "../../src/lib/db/repos/usageRepo.js";
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";

const log = { debug() {}, info() {}, warn() {}, line() {}, errorLine() {} };
const account = "lifecycle-account";
const model = "gpt-5.6-sol";
const start = (requestId) => trackPendingRequest(model, "codex", account, true, false, { requestId, requestedModel: model, endpoint: "/v1/responses" });
const active = async () => (await getActiveRequests()).activeRequests.filter(item => item.connectionId === account);
const options = (stream = true) => ({
  body: { model, input: "hello", stream }, modelInfo: { provider: "codex", model },
  credentials: { accessToken: "test", providerSpecificData: {} }, connectionId: account,
  sourceFormatOverride: "openai-responses", userAgent: "codex-cli/0.144.1",
  clientRawRequest: { endpoint: "/v1/responses", body: { model }, headers: {} },
  rtkEnabled: false, headroomEnabled: false, cavemanEnabled: false, ponytailEnabled: false, pxpipeEnabled: false,
  requestId: "core-request", log,
});
const upstream = (response) => execute.mockResolvedValue({ response, url: "https://example.test/responses", headers: {}, transformedBody: null });

beforeEach(() => { execute.mockReset(); appendRequestLog.mockClear(); });
afterEach(() => {
  for (const state of [global._pendingRequests.byModel, global._pendingRequests.byAccount, global._pendingRequestDetails, global._pendingRequestStarts]) {
    for (const key of Object.keys(state)) delete state[key];
  }
  vi.useRealTimers();
});

it("keeps request metadata and latency after more than 60 seconds until completion", async () => {
  vi.useFakeTimers();
  const finish = start("long");
  await vi.advanceTimersByTimeAsync(125000);
  expect(await active()).toMatchObject([{ count: 1, latencyMs: 125000, requests: [{ requestId: "long", endpoint: "/v1/responses", latencyMs: 125000 }] }]);
  finish();
  expect(await active()).toEqual([]);
});

it("removes the exact request once when same-account requests finish out of order", async () => {
  const first = start("first");
  const second = start("second");
  second(); second(true);
  expect(await active()).toMatchObject([{ count: 1, requests: [{ requestId: "first" }] }]);
  first();
  expect(await active()).toEqual([]);
});

it.each(["handleComplete", "handleDisconnect", "handleError"])("cleans up through %s without removing another request", async (method) => {
  const finish = start("first");
  const other = start("other");
  const controller = createStreamController({ onComplete: finish, onDisconnect: () => finish(), onError: () => finish(true), log });
  controller[method](new DOMException("aborted", "AbortError"));
  controller.handleComplete();
  expect(await active()).toMatchObject([{ count: 1, requests: [{ requestId: "other" }] }]);
  other();
});

it("tracks a real streaming chat until EOF and leaves a simultaneous request intact", async () => {
  let source;
  upstream(new Response(new ReadableStream({ start(controller) { source = controller; } }), { headers: { "content-type": "text/event-stream" } }));
  const result = await handleChatCore(options());
  const finishOther = start("other");
  const body = result.response.text();
  source.enqueue(new TextEncoder().encode('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n'));
  source.close();
  await body;
  expect(await active()).toMatchObject([{ count: 1, requests: [{ requestId: "other" }] }]);
  finishOther();
});

it("keeps non-streaming details while the upstream response body is still arriving", async () => {
  let source;
  upstream(new Response(new ReadableStream({ start(controller) { source = controller; } }), { headers: { "content-type": "application/json" } }));
  const result = handleChatCore({
    ...options(false),
    body: { model: "deepseek-chat", messages: [{ role: "user", content: "hello" }], stream: false },
    modelInfo: { provider: "deepseek", model: "deepseek-chat" }, sourceFormatOverride: "openai",
  });
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  expect(await active()).toMatchObject([{ count: 1, requests: [{ requestId: "core-request" }] }]);
  source.enqueue(new TextEncoder().encode('{"id":"r","choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}'));
  source.close();
  await result;
  expect(await active()).toEqual([]);
});

it("cleans up when the client cancels a real streaming response", async () => {
  upstream(new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } }));
  const result = await handleChatCore(options());
  await result.response.body.cancel();
  expect(await active()).toEqual([]);
});

it("keeps forced-stream JSON requests visible until the upstream stream ends", async () => {
  let source;
  upstream(new Response(new ReadableStream({ start(controller) { source = controller; } }), { headers: { "content-type": "text/event-stream" } }));
  const result = handleChatCore(options(false));
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  expect(await active()).toMatchObject([{ count: 1 }]);
  source.enqueue(new TextEncoder().encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}\n\n'));
  source.close();
  await result;
  expect(await active()).toEqual([]);
});

it("cleans up an upstream fetch failure without touching another request", async () => {
  const finishOther = start("other");
  execute.mockRejectedValue(new Error("fetch failed"));
  const context = options();
  Object.assign(context.clientRawRequest, { apiKeyRecordId: "caller-1", apiKeyName: "客户端甲", apiKeyMasked: "test...1234", clientIp: "192.0.2.10", headers: { "user-agent": "test-cli/1.0" } });
  await handleChatCore(context);
  expect(appendRequestLog).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED 502", apiKeyId: "caller-1", apiKeyName: "客户端甲", clientIp: "192.0.2.10", userAgent: "test-cli/1.0", requestedModel: model, endpoint: "/v1/responses" }));
  expect(await active()).toMatchObject([{ count: 1, requests: [{ requestId: "other" }] }]);
  finishOther();
});

it("passes the full active request snapshot to overload logging", async () => {
  const overload = vi.fn();
  execute.mockImplementation(async ({ onUpstreamOverload }) => {
    onUpstreamOverload({ message: "busy", upstreamStatus: 503 });
    return { response: new Response('{"error":{"message":"busy"}}', { status: 503, headers: { "content-type": "application/json" } }), headers: {}, url: "https://example.test/responses" };
  });
  const context = options();
  context.body.reasoning = { effort: "high" };
  Object.assign(context.clientRawRequest, { apiKeyName: "客户端甲", clientIp: "192.0.2.10", waitMs: 1200 });
  await handleChatCore({ ...context, onUpstreamOverload: overload });
  expect(overload).toHaveBeenCalledWith(expect.objectContaining({ requestContext: expect.objectContaining({
    apiKeyName: "客户端甲", clientIp: "192.0.2.10", requestedModel: model, upstreamModel: model,
    thinkingLevel: "high", stream: true, sourceFormat: "openai-responses", targetFormat: "openai-responses",
    startedAt: expect.any(Number), latencyMs: expect.any(Number), requestBytes: expect.any(Number), waitMs: 1200, state: "running",
  }) }));
});
