import { describe, expect, it, vi } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { BaseExecutor } from "../../open-sse/executors/base.js";

function streamFromText(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

describe("Codex fast tier and capacity handling", () => {
  it("logs the original 200-SSE error and upstream id before converting it to 503", async () => {
    const executor = new CodexExecutor();
    executor.config = { ...executor.config, retry: { 503: { attempts: 0, delayMs: 0 } } };
    const call = vi.spyOn(BaseExecutor.prototype, "execute").mockResolvedValue({ response: new Response(streamFromText(
      'event: error\ndata: {"error":{"code":"server_is_overloaded","message":"busy"}}\n\n'
    ), { headers: { "x-request-id": "upstream-123", "content-type": "text/event-stream" } }) });
    try {
      const log = { warn: vi.fn() };
      const onUpstreamOverload = vi.fn();
      const result = await executor.execute({ model: "gpt-5.6-terra", body: { input: [] }, credentials: {}, log,
        onUpstreamOverload,
        diagnosticContext: { requestId: "local-123", connectionId: "account-a", retryCount: 2 } });
      expect(result.response.status).toBe(503);
      expect(onUpstreamOverload).toHaveBeenCalledTimes(1);
      expect(onUpstreamOverload).toHaveBeenCalledWith(expect.objectContaining({
        upstreamStatus: 200, retryCount: 2, sseAttempt: 1,
        message: JSON.stringify({ code: "server_is_overloaded", message: "busy" }),
        headers: { "x-request-id": "upstream-123" },
      }));
      expect(log.warn).toHaveBeenCalledWith("UPSTREAM_SSE_ERROR", "codex", expect.objectContaining({
        requestId: "local-123", connectionId: "account-a", retryCount: 2, sseAttempt: 1,
        upstreamStatus: 200, headers: { "x-request-id": "upstream-123" },
        error: { code: "server_is_overloaded", message: "busy" }, willRetry: false,
      }));
    } finally { call.mockRestore(); }
  });
  it("maps Codex fast tier to priority and max reasoning to xhigh", () => {
    const executor = new CodexExecutor();
    const body = executor.transformRequest("gpt-5.5", {
      model: "gpt-5.5",
      input: "hi",
      reasoning_effort: "max",
      service_tier: "fast",
    }, true, {});

    expect(body.service_tier).toBe("priority");
    expect(body.reasoning.effort).toBe("xhigh");
  });

  it("uses ChatGPT workspace header fallback", () => {
    const executor = new CodexExecutor();
    const headers = executor.buildHeaders({
      accessToken: "token",
      connectionId: "conn_1",
      providerSpecificData: { chatgptAccountId: "acct_1" },
    });

    expect(headers["ChatGPT-Account-ID"]).toBe("acct_1");
  });

  it("classifies 200-SSE model capacity as account fallback", async () => {
    const executor = new CodexExecutor();
    const response = new Response(streamFromText([
      "event: error",
      'data: {"error":{"message":"Selected model is at capacity. Please try a different model."}}',
      "",
    ].join("\n")), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.accountFallback).toBe(true);
    expect(peek.message).toBe("Selected model is at capacity. Please try a different model.");
  });

  it("reassembles normal SSE after peeking", async () => {
    const executor = new CodexExecutor();
    const text = [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"OK"}',
      "",
    ].join("\n");
    const response = new Response(streamFromText(text), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBeNull();
    await expect(new Response(peek.replacementBody).text()).resolves.toBe(text);
  });
});

describe("Codex reasoning normalization", () => {
  it.each([
    ["gpt-5.6-sol", "max", "max"],
    ["gpt-5.6-sol", "ultra", "ultra"],
    ["gpt-5.6-terra", "max", "max"],
    ["gpt-5.6-terra", "ultra", "ultra"],
    ["gpt-5.6-luna", "max", "max"],
    ["gpt-5.6-luna", "ultra", "max"],
  ])("normalizes %s effort %s to %s", (model, effort, expected) => {
    const body = new CodexExecutor().transformRequest(model, {
      model,
      input: "hi",
      reasoning: { effort },
    }, true, {});

    expect(body.reasoning.effort).toBe(expected);
  });

  it("resolves review models before applying the reasoning matrix", () => {
    const body = new CodexExecutor().transformRequest("gpt-5.6-terra-review", {
      model: "gpt-5.6-terra-review",
      input: "hi",
      reasoning_effort: "ultra",
    }, true, {});

    expect(body.model).toBe("gpt-5.6-terra");
    expect(body.reasoning.effort).toBe("ultra");
  });

  it("removes reasoning summaries unsupported by Spark", () => {
    const body = new CodexExecutor().transformRequest("gpt-5.3-codex-spark", {
      model: "gpt-5.3-codex-spark",
      input: "hi",
      reasoning: { effort: "high", summary: "auto" },
    }, true, {});

    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.context_management).toEqual([
      { type: "compaction", compact_threshold: 100000 },
    ]);
  });

  it("clamps Spark compaction below its context limit", () => {
    const body = new CodexExecutor().transformRequest("gpt-5.3-codex-spark", {
      model: "gpt-5.3-codex-spark",
      input: "hi",
      context_management: [{ type: "compaction", compact_threshold: 200000 }],
    }, true, {});

    expect(body.context_management).toEqual([
      { type: "compaction", compact_threshold: 100000 },
    ]);
  });

  it("keeps context management off standalone compact requests", () => {
    const body = new CodexExecutor().transformRequest("gpt-5.3-codex-spark", {
      model: "gpt-5.3-codex-spark",
      input: "hi",
      _compact: true,
    }, true, {});

    expect(body.context_management).toBeUndefined();
  });
});
