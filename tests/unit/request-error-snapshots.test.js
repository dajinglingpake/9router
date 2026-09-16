import { afterEach, expect, it, vi } from "vitest";
import { getRequestLogContext, getRequestTokenUsage } from "../../src/lib/requestCaller.js";
import { acquireConcurrencySlot, getConcurrencySnapshot } from "../../src/sse/services/concurrencyLimiter.js";

afterEach(() => vi.useRealTimers());

it("captures elapsed time and the active request fields without copying secrets or bodies", () => {
  const snapshot = getRequestLogContext({
    apiKeyRecordId: "caller", apiKeyName: "测试客户端", apiKeyMasked: "test...1234", apiKey: "raw-key",
    body: { model: "client-alias", messages: ["private content"] },
    headers: new Headers({ "user-agent": "test-cli/1.0", authorization: "Bearer secret" }),
    clientIp: "192.0.2.10", upstreamModel: "upstream-model", thinkingLevel: "high",
    sourceFormat: "openai-responses", targetFormat: "openai-responses", stream: false,
    requestBytes: 2048, estimatedInputTokens: 300, tokens: { input_tokens: 220, output_tokens: 0 }, startedAt: 1000, deadline: 5000, state: "running", waitMs: 0,
  }, 2500);
  expect(snapshot).toMatchObject({ apiKeyId: "caller", apiKeyName: "测试客户端", requestedModel: "client-alias", userAgent: "test-cli/1.0", upstreamModel: "upstream-model", thinkingLevel: "high", stream: false, requestBytes: 2048, latencyMs: 1500, timeoutRemainingMs: 2500, waitMs: 0 });
  expect(JSON.stringify(snapshot)).not.toMatch(/raw-key|private content|secret|authorization/);
  expect(snapshot).toMatchObject({ estimatedInputTokens: 300, inputTokens: 220, outputTokens: 0 });
  expect(getRequestLogContext(snapshot, 10000)).toEqual(snapshot);
  expect(getRequestLogContext(null).startedAt).toBeNull();
});

it("distinguishes missing, estimated and cache-inclusive provider usage", () => {
  expect(getRequestTokenUsage()).toEqual({ inputTokens: null, outputTokens: null });
  expect(getRequestTokenUsage({ prompt_tokens: 500, completion_tokens: 2, estimated: true })).toEqual({ inputTokens: null, outputTokens: null });
  expect(getRequestTokenUsage({ input_tokens: 20, cache_read_input_tokens: 100, output_tokens: 0 })).toEqual({ inputTokens: 120, outputTokens: 0 });
  expect(getRequestTokenUsage({ input_tokens: 120, input_tokens_details: { cached_tokens: 100 } })).toEqual({ inputTokens: 120, outputTokens: null });
});

it.each(["timeout", "cancel"])("captures the visible queue position before %s removes the request", async (action) => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const id = `error-snapshot-${action}`;
  const permit = await acquireConcurrencySlot({ scope: "account", id, limit: 1 });
  const queuedAt = Date.now();
  const metadata = { providerScope: "codex", routingModel: "sol", requestedModel: "client-alias", upstreamModel: "sol", thinkingLevel: "high", requestBytes: 2048, estimatedInputTokens: 300, userAgent: "test-cli/1.0", stream: true, apiKeyName: "客户端甲", clientIp: "192.0.2.10", endpoint: "/v1/responses" };
  const result = acquireConcurrencySlot({ scope: "account", id, limit: 1, signal: controller.signal, requestId: "request-1", deadline: queuedAt + 1000, metadata }).catch(error => error);
  expect(getConcurrencySnapshot().find(pool => pool.id === id).queue[0]).toMatchObject({ position: 1, thinkingLevel: "high", requestBytes: 2048 });
  await vi.advanceTimersByTimeAsync(action === "timeout" ? 1000 : 500);
  if (action === "cancel") controller.abort();
  const error = await result;
  expect(error.requestContext).toMatchObject({ userAgent: "test-cli/1.0", estimatedInputTokens: 300 });
  expect(error.requestContext).toMatchObject({ requestId: "request-1", position: 1, queuedAt, state: "queued", waitMs: action === "timeout" ? 1000 : 500, timeoutRemainingMs: action === "timeout" ? 0 : 500, thinkingLevel: "high", apiKeyName: "客户端甲", requestBytes: 2048 });
  expect(getConcurrencySnapshot().find(pool => pool.id === id).queued).toBe(0);
  permit.release();
});
