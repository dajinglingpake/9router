import { beforeEach, describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
  }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const { getThinkingLevels } = await import("../../open-sse/providers/thinkingLevels.js");
const { applyThinking } = await import("../../open-sse/translator/concerns/thinkingUnified.js");

beforeEach(() => vi.clearAllMocks());

describe("official OpenAI native Responses routing", () => {
  it.each([false, true])("preserves Codex custom tools and results with stream=%s", async stream => {
    const model = "gpt-6.1-sol";
    const tools = [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", description: "Execute JavaScript", format: { type: "text" } }] }];
    const input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Write index.html" }] },
      { type: "custom_tool_call", call_id: "call_1", name: "exec", namespace: "functions", input: "return 1;" },
      { type: "custom_tool_call_output", call_id: "call_1", output: "1" },
    ];
    const text = { format: { type: "text" }, verbosity: "low" };
    const output = [{ type: "custom_tool_call", id: "ctc_2", call_id: "call_2", name: "exec", namespace: "functions", input: "writeFile('index.html', '<html></html>');", status: "completed" }];
    const response = { id: "resp_test", object: "response", model, status: "completed", output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
    const events = [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...output[0], input: "", status: "in_progress" } },
      { type: "response.custom_tool_call_input.delta", output_index: 0, item_id: "ctc_2", delta: output[0].input },
      { type: "response.output_item.done", output_index: 0, item: output[0] },
      { type: "response.completed", response },
    ];
    const executor = new DefaultExecutor("openai");
    executeMock.mockImplementationOnce(async ({ body, credentials }) => ({
      response: new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      }),
      url: executor.buildUrl(model, true, 0, credentials),
      headers: {}, transformedBody: body,
    }));
    const credentials = { apiKey: "test-key", providerSpecificData: {} };
    const result = await handleChatCore({
      body: { model: `openai/${model}`, input: structuredClone(input), tools, text, stream, reasoning: { effort: "minimal" }, store: false },
      modelInfo: { provider: "openai", model }, credentials, connectionId: "openai-test",
      sourceFormatOverride: "openai-responses", log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });
    expect(result.success).toBe(true);
    const sent = executeMock.mock.calls[0][0];
    expect(executor.buildUrl(model, true, 0, sent.credentials)).toBe("https://api.openai.com/v1/responses");
    expect(sent.body).toMatchObject({ input, tools, text, store: false, reasoning: { effort: "low" } });
    expect(sent.body.messages).toBeUndefined();
    expect(sent.body.reasoning_effort).toBeUndefined();
    expect(executor.buildHeaders(credentials, true).Authorization).toBe("Bearer test-key");
    const returned = await result.response.text();
    if (stream) {
      expect(returned).toContain("response.custom_tool_call_input.delta");
      expect(returned).toContain('"namespace":"functions"');
      expect(returned).toContain("response.completed");
    } else expect(JSON.parse(returned).output).toEqual(output);
  });

  it("keeps ordinary Chat Completions on its existing endpoint", () => {
    expect(new DefaultExecutor("openai").buildUrl("gpt-4o", true, 0, { apiKey: "test-key" }))
      .toBe("https://api.openai.com/v1/chat/completions");
  });
});

describe("official GPT-6 reasoning levels", () => {
  it.each(["gpt-6.1-sol", "gpt-6-astra"])("%s excludes unsupported none/minimal and allows max", model => {
    expect(getThinkingLevels("openai", model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    for (const format of ["openai", "openai-responses"]) {
      for (const effort of ["none", "minimal", "low", "max"]) {
        const body = applyThinking(format, model, { reasoning: { effort } }, "openai");
        expect(format === "openai" ? body.reasoning_effort : body.reasoning.effort)
          .toBe(["none", "minimal"].includes(effort) ? "low" : effort);
      }
    }
  });

  it.each(["gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna"])("%s still allows disabling reasoning", model => {
    expect(getThinkingLevels("openai", model)).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(applyThinking("openai", model, { reasoning_effort: "none" }, "openai").reasoning_effort).toBe("none");
  });

  it("does not replace the separate Codex subscription levels", () => {
    expect(getThinkingLevels("codex", "gpt-6-luna")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(applyThinking("openai", "gpt-5", { reasoning_effort: "max" }, "openai").reasoning_effort).toBe("xhigh");
  });
});
