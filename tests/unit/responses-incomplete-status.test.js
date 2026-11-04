import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

import { FORMATS } from "../../open-sse/translator/formats.js";
import { initState } from "../../open-sse/translator/index.js";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import { createResponsesApiTransformStream } from "../../open-sse/transformer/responsesTransformer.js";
import { convertResponsesStreamToJson } from "../../open-sse/transformer/streamToJsonConverter.js";
import { translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { buildOnStreamComplete } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { saveRequestDetail } from "@/lib/usageDb.js";

const usage = { prompt_tokens: 8232, completion_tokens: 32768, completion_tokens_details: { reasoning_tokens: 32768 } };
const reasoning = { id: "chatcmpl-limit", choices: [{ index: 0, delta: { reasoning_content: "still planning" } }] };
const finish = (reason, tokens) => ({ id: "chatcmpl-limit", choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: tokens });
const terminalEvents = events => events.filter(e => ["response.completed", "response.incomplete", "response.failed"].includes(e.type));
const wire = chunks => chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
const inputStream = text => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } });
const parse = text => text.split("\n").filter(l => l.startsWith("data: ") && l !== "data: [DONE]").map(l => JSON.parse(l.slice(6)));

async function transform(chunks, options = {}) {
  const onStreamComplete = vi.fn();
  const stream = inputStream(wire(chunks)).pipeThrough(createSSEStream({
    targetFormat: FORMATS.OPENAI, sourceFormat: FORMATS.OPENAI_RESPONSES,
    onStreamComplete, ...options,
  }));
  return { events: parse(await new Response(stream).text()), onStreamComplete };
}

describe("Responses incomplete termination", () => {
  it.each(["finish", "trailer", "absent"])("preserves reasoning-only length with %s usage", async placement => {
    const chunks = [reasoning, finish("length", placement === "finish" ? usage : undefined)];
    if (placement === "trailer") chunks.push({ choices: [], usage });
    const { events, onStreamComplete } = await transform(chunks);
    expect(terminalEvents(events)).toHaveLength(1);
    const terminal = terminalEvents(events)[0];
    expect(terminal).toMatchObject({ type: "response.incomplete", response: {
      status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "reasoning", summary: [{ text: "still planning" }] }],
    } });
    if (placement !== "absent") expect(terminal.response.usage).toMatchObject({ output_tokens: 32768, output_tokens_details: { reasoning_tokens: 32768 } });
    expect(onStreamComplete).toHaveBeenCalledWith(expect.objectContaining({ successful: false }), expect.anything(), expect.anything());
  });

  it("preserves content filtering and partial text", async () => {
    const { events } = await transform([{ choices: [{ delta: { content: "partial" } }] }, finish("content_filter", usage)]);
    expect(terminalEvents(events)).toEqual([expect.objectContaining({ type: "response.incomplete", response: expect.objectContaining({
      status: "incomplete", incomplete_details: { reason: "content_filter" },
      output: [expect.objectContaining({ content: [expect.objectContaining({ text: "partial" })] })],
    }) })]);
  });

  it("does not lose length on the last inline thinking delta", async () => {
    const { events } = await transform([{ choices: [{ delta: { content: "<think>unfinished" }, finish_reason: "length" }], usage }]);
    expect(terminalEvents(events)[0]).toMatchObject({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } });
  });

  it.each(["stop", "tool_calls"])("keeps %s as normal completion", async reason => {
    const delta = reason === "stop" ? { content: "done" } : { tool_calls: [{ index: 0, id: "call_1", function: { name: "write", arguments: "{}" } }] };
    const { events, onStreamComplete } = await transform([{ choices: [{ delta }] }, finish(reason, usage)]);
    expect(terminalEvents(events)).toEqual([expect.objectContaining({ type: "response.completed", response: expect.objectContaining({ status: "completed" }) })]);
    expect(terminalEvents(events)[0].response).not.toHaveProperty("incomplete_details");
    expect(onStreamComplete).toHaveBeenCalledWith(expect.objectContaining({ successful: true }), expect.anything(), expect.anything());
  });

  it("keeps length when a Claude response pivots through Chat Completions", async () => {
    const { events } = await transform([
      { type: "message_start", message: { id: "msg_limit", model: "test", usage: { input_tokens: 4 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 8 } },
      { type: "message_stop" },
    ], { targetFormat: FORMATS.CLAUDE });
    expect(terminalEvents(events)).toHaveLength(1);
    expect(terminalEvents(events)[0]).toMatchObject({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } });
  });

  it("emits incomplete only once across usage, DONE, and repeated flush", () => {
    const state = { ...initState(FORMATS.OPENAI_RESPONSES), targetFormat: FORMATS.OPENAI };
    const events = [reasoning, finish("length"), { choices: [], usage }, null, null]
      .flatMap(c => openaiToOpenAIResponsesResponse(c, state)).map(e => e.data);
    expect(terminalEvents(events)).toHaveLength(1);
    expect(terminalEvents(events)[0].type).toBe("response.incomplete");
  });

  it.each(["length", "content_filter"])("preserves %s in the legacy stream adapter", async reason => {
    const events = parse(await new Response(inputStream(wire([reasoning, finish(reason, usage)])).pipeThrough(createResponsesApiTransformStream())).text());
    expect(terminalEvents(events)).toHaveLength(1);
    expect(terminalEvents(events)[0]).toMatchObject({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: reason === "length" ? "max_output_tokens" : reason } } });
  });

  it.each(["length", "content_filter"])("returns valid non-streaming status for %s", reason => {
    const response = translateNonStreamingResponse({ id: "test", choices: [{ message: { role: "assistant", content: "partial" }, finish_reason: reason }], usage }, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);
    expect(response).toMatchObject({ status: "incomplete", incomplete_details: { reason: reason === "length" ? "max_output_tokens" : reason } });
  });

  it("preserves length when a chat provider forces SSE for a JSON client", async () => {
    const result = await handleForcedSSEToJson({
      providerResponse: new Response(inputStream(wire([reasoning, finish("length", usage)])), { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: FORMATS.OPENAI_RESPONSES, targetFormat: FORMATS.OPENAI,
      provider: "test", model: "test", body: {}, stream: false,
      requestStartTime: Date.now(), clientRawRequest: { endpoint: "/v1/responses" },
      trackDone: vi.fn(), appendLog: vi.fn(),
    });
    expect(await result.response.json()).toMatchObject({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } });
  });

  it("recognizes incomplete as a terminal event without inventing a disconnection", async () => {
    const terminal = { type: "response.incomplete", response: { id: "resp_limit", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 1, output_tokens: 8, total_tokens: 9 } } };
    const { events, onStreamComplete } = await transform([terminal], { targetFormat: FORMATS.OPENAI_RESPONSES });
    expect(terminalEvents(events)).toEqual([terminal]);
    expect(onStreamComplete.mock.calls[0][0]).toMatchObject({ successful: false });
  });

  it("preserves incomplete details, usage, and output when collecting Responses SSE as JSON", async () => {
    const output = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "partial" }] }];
    const response = { id: "resp_limit", status: "incomplete", output, incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 1, output_tokens: 8, total_tokens: 9, output_tokens_details: { reasoning_tokens: 6 } } };
    const json = await convertResponsesStreamToJson(inputStream(`event: response.incomplete\ndata: ${JSON.stringify({ type: "response.incomplete", response })}\n\n`));
    expect(json).toMatchObject(response);
  });

  it.each(["max_output_tokens", "content_filter"])("preserves %s when converting Responses back to Chat", async reason => {
    const { events } = await transform([
      { type: "response.created", response: { id: "resp_limit" } },
      { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason }, usage: { input_tokens: 1, output_tokens: 8 } } },
    ], { targetFormat: FORMATS.OPENAI_RESPONSES, sourceFormat: FORMATS.OPENAI });
    expect(events.filter(e => e.choices?.[0]?.finish_reason).map(e => e.choices[0].finish_reason)).toEqual([reason === "max_output_tokens" ? "length" : reason]);
  });

  it("records the upstream finish reason and never records truncation as success", async () => {
    const onRequestComplete = vi.fn();
    const { onStreamComplete } = buildOnStreamComplete({ provider: "test", model: "test", body: {}, requestStartTime: Date.now(), onRequestComplete });
    await transform([reasoning, finish("length", usage)], { onStreamComplete });
    expect(onRequestComplete).not.toHaveBeenCalled();
    expect(saveRequestDetail).toHaveBeenLastCalledWith(expect.objectContaining({
      status: "error", response: expect.objectContaining({ status: "incomplete", finish_reason: "length", incomplete_details: { reason: "max_output_tokens" } }),
    }));
  });
});
