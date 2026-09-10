import { describe, expect, it } from "vitest";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

async function runChatToResponses(input) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });
  const output = stream.pipeThrough(
    createSSETransformStreamWithLogger(
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
      "deepseek",
      null,
      null,
      "deepseek-v4-flash-vision-exp",
    ),
  );
  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

describe("OpenAI Chat stream -> Responses usage", () => {
  it("includes usage from the final usage-only chunk in response.completed", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    const chunks = [
      {
        id: "chatcmpl-usage",
        choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
      },
      {
        id: "chatcmpl-usage",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
      {
        id: "chatcmpl-usage",
        choices: [],
        usage: {
          prompt_tokens: 1209107,
          completion_tokens: 12,
          total_tokens: 1209119,
          prompt_tokens_details: { cached_tokens: 7 },
          completion_tokens_details: { reasoning_tokens: 3 },
        },
      },
    ];

    const events = chunks.flatMap((chunk) => openaiToOpenAIResponsesResponse(chunk, state));
    const completed = events.find((event) => event.event === "response.completed");

    expect(completed).toBeTruthy();
    expect(completed.data.response.usage).toEqual({
      input_tokens: 1209107,
      input_tokens_details: { cached_tokens: 7 },
      output_tokens: 12,
      output_tokens_details: { reasoning_tokens: 3 },
      total_tokens: 1209119,
    });
  });

  it("includes usage when it arrives on the finish chunk", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    const events = openaiToOpenAIResponsesResponse({
      id: "chatcmpl-usage-finish",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 101, completion_tokens: 5, total_tokens: 106 },
    }, state);

    const completed = events.find((event) => event.event === "response.completed");
    expect(completed.data.response.usage).toEqual({
      input_tokens: 101,
      output_tokens: 5,
      total_tokens: 106,
    });
  });

  it("preserves usage through the full SSE transform", async () => {
    const output = await runChatToResponses([
      `data: ${JSON.stringify({
        id: "chatcmpl-stream",
        choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
      })}`,
      "",
      `data: ${JSON.stringify({
        id: "chatcmpl-stream",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}`,
      "",
      `data: ${JSON.stringify({
        id: "chatcmpl-stream",
        choices: [],
        usage: { prompt_tokens: 321, completion_tokens: 12, total_tokens: 333 },
      })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n"));

    const completedLine = output
      .split("\n")
      .find((line) => line.startsWith("data: ") && line.includes('"type":"response.completed"'));
    const completed = JSON.parse(completedLine.slice(6));
    expect(completed.response.usage).toEqual({
      input_tokens: 321,
      output_tokens: 12,
      total_tokens: 333,
    });
  });
});

describe("DeepSeek stream usage request", () => {
  it("asks DeepSeek for stream usage on the Chat Completions transport", () => {
    const executor = new DefaultExecutor("deepseek");
    const body = {
      model: "deepseek-v4-flash-vision-exp",
      messages: [],
      stream: true,
    };

    const out = executor.transformRequest(
      "deepseek-v4-flash-vision-exp",
      body,
      true,
      { runtimeTransport: { format: "openai" } }
    );

    expect(out.stream_options).toEqual({ include_usage: true });
  });

  it("does not inject Chat stream_options into the Claude transport", () => {
    const executor = new DefaultExecutor("deepseek");
    const body = {
      model: "deepseek-v4-flash-vision-exp",
      messages: [],
      stream: true,
    };

    const out = executor.transformRequest(
      "deepseek-v4-flash-vision-exp",
      body,
      true,
      { runtimeTransport: { format: "claude" } }
    );

    expect(out.stream_options).toBeUndefined();
  });
});
