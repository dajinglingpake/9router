import { beforeEach, describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => ({ noAuth: true, execute: executeMock }) }));
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
const { CodeBuddyExecutor } = await import("../../open-sse/executors/codebuddy-cn.js");
const { translateNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { collectResponsesToolNamespaces } = await import("../../open-sse/translator/formats/responsesApi.js");

const program = 'await tools.apply_patch("*** Begin Patch\\n*** Add File: pelican.svg\\n+<svg>鹈鹕</svg>\\n*** End Patch");';
const namespace = { type: "namespace", name: "functions", tools: [
  { type: "custom", name: "exec", format: { type: "grammar", syntax: "lark", definition: "start: /(.|\\n)+/" } },
  { type: "custom", name: "apply_patch", description: "Apply a patch to a file." },
  { type: "function", name: "wait", parameters: { type: "object", properties: { cell_id: { type: "string" } } } },
] };

function upstreamResponse() {
  const args = JSON.stringify({ input: program });
  const deltas = [
    { reasoning_content: "Need to write the file." },
    { content: "Writing the file." },
    { tool_calls: [{ index: 0, id: "call_exec", type: "function", function: { arguments: "" } }] },
    { tool_calls: [{ index: 0, function: { name: "exec", arguments: args.slice(0, 17) } }] },
    { tool_calls: [{ index: 1, id: "call_wait", type: "function", function: { name: "wait", arguments: '{"cell_id":"job"}' } }] },
    { tool_calls: [{ index: 0, function: { arguments: args.slice(17) } }] },
  ];
  const chunks = [
    ...deltas.map(delta => ({ id: "chatcmpl-test", choices: [{ index: 0, delta, finish_reason: null }] })),
    { id: "chatcmpl-test", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    { id: "chatcmpl-test", choices: [], usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } },
  ];
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

async function route(body) {
  return handleChatCore({
    body: { model: "cbcn/kimi-k3.1-pro", ...body },
    modelInfo: { provider: "codebuddy-cn", model: "kimi-k3.1-pro" },
    credentials: { accessToken: "test-token", providerSpecificData: {} },
    connectionId: "codebuddy-custom-test", sourceFormatOverride: "openai-responses",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
  });
}

describe("CodeBuddy Codex custom tools through the real chat pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockImplementation(async ({ body, credentials }) => ({
      response: upstreamResponse(), url: "https://copilot.tencent.com/v2/chat/completions", headers: {},
      transformedBody: new CodeBuddyExecutor().transformRequest(body.model, body, true, credentials),
    }));
  });

  it.each([
    { stream: true, deferred: false }, { stream: false, deferred: false },
    { stream: true, deferred: true }, { stream: false, deferred: true },
  ])("preserves namespace, custom input and result continuation: %j", async ({ stream, deferred }) => {
    const input = [
      ...(deferred ? [{ type: "additional_tools", tools: [namespace] }] : []),
      { role: "user", content: "Create pelican.svg." },
    ];
    const body = { input, stream, ...(!deferred && { tools: [namespace] }) };
    const result = await route(body);
    expect(result.success).toBe(true);
    const upstream = executeMock.mock.calls[0][0].body;
    expect(upstream.tools.map(tool => tool.function.name)).toEqual(["exec", "apply_patch", "wait"]);
    expect(upstream.tools[0].function.parameters.required).toEqual(["input"]);
    expect(upstream.tools[0].function.description).toContain("start:");
    expect(upstream._customToolNames).toBeUndefined();

    const text = await result.response.text();
    const events = stream ? text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))) : [];
    const output = stream ? events.find(event => event.type === "response.completed")?.response.output : JSON.parse(text).output;
    const call = output.find(item => item.type === "custom_tool_call");
    expect(output).toHaveLength(4);
    expect(call).toMatchObject({ name: "exec", namespace: "functions", input: program, call_id: "call_exec" });
    expect(output.find(item => item.type === "function_call")).toMatchObject({ name: "wait", namespace: "functions", call_id: "call_wait" });
    if (stream) {
      const added = events.filter(event => event.type === "response.output_item.added");
      expect(new Set(added.map(event => event.output_index)).size).toBe(added.length);
      expect(events.filter(event => event.type === "response.custom_tool_call_input.delta").map(event => event.delta).join("")).toBe(program);
      expect(events.find(event => event.type === "response.output_item.added" && event.item.name === "exec").item.namespace).toBe("functions");
      expect(events.find(event => event.type === "response.output_item.done" && event.item.name === "exec").item).toEqual(call);
    }

    const continuation = await route({ ...body, stream: false, input: [
      ...input, ...output,
      { type: "custom_tool_call_output", call_id: "call_exec", output: "Successfully wrote pelican.svg" },
      { type: "function_call_output", call_id: "call_wait", output: "Completed" },
      { role: "user", content: "Read the generated file." },
    ] });
    await continuation.response.text();
    const history = executeMock.mock.calls.at(-1)[0].body.messages;
    expect(history.flatMap(message => message.tool_calls || [])).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "call_exec", function: { name: "exec", arguments: JSON.stringify({ input: program }) } }),
    ]));
    expect(history).toEqual(expect.arrayContaining([
      { role: "tool", tool_call_id: "call_exec", content: "Successfully wrote pelican.svg" },
      { role: "tool", tool_call_id: "call_wait", content: "Completed" },
    ]));
  });

  it("restores custom-tool namespaces for native JSON upstream responses", () => {
    const response = { choices: [{ message: { tool_calls: [{ id: "call_exec", function: { name: "exec", arguments: JSON.stringify({ input: program }) } }] }, finish_reason: "tool_calls" }] };
    const out = translateNonStreamingResponse(response, "openai", "openai-responses", new Set(["exec"]), collectResponsesToolNamespaces({ tools: [namespace] }));
    expect(out.output[0]).toMatchObject({ type: "custom_tool_call", name: "exec", namespace: "functions", input: program });
  });

  it("recovers namespaces from custom and function call history", () => {
    expect(collectResponsesToolNamespaces({ input: [
      { type: "custom_tool_call", namespace: "functions", name: "exec" },
      { type: "function_call", namespace: "functions", name: "wait" },
    ] })).toEqual(new Map([["exec", "functions"], ["wait", "functions"]]));
  });
});
