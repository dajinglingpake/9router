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
const { restoreToolNames } = await import("../../open-sse/utils/opencodeFingerprint.js");

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
    const assistantTurns = history.filter(message => message.role === "assistant");
    expect(assistantTurns).toHaveLength(1);
    expect(assistantTurns[0]).toMatchObject({
      content: [{ type: "text", text: "Writing the file." }],
      reasoning_content: "Need to write the file.",
    });
    expect(assistantTurns[0].tool_calls.map(tool => tool.id)).toEqual(["call_exec", "call_wait"]);
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

  it.each([
    { stream: true }, { stream: false },
  ])("keeps both desktop REPL tools callable across a round trip: %j", async ({ stream }) => {
    const tools = ["mcp__cua_repl", "mcp__node_repl"].map((name, index) => ({
      type: "namespace", name, tools: [{
        type: index ? "custom" : "function", name: "js", description: `${name} JavaScript`,
        parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
      }],
    }));
    executeMock.mockImplementation(async ({ body }) => {
      const calls = body.tools.map((tool, index) => ({
        index, id: `call_${index}`, type: "function",
        function: { name: tool.function.name, arguments: JSON.stringify(index ? { input: "2+2" } : { code: "1+1" }) },
      }));
      return { response: new Response([
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: calls }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream" } }), transformedBody: body };
    });
    const input = [{ role: "user", content: "Use both JavaScript runtimes." }];
    const result = await route({ tools, input, stream });
    const text = await result.response.text();
    const events = stream ? text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))) : [];
    const output = stream ? events.find(event => event.type === "response.completed").response.output : JSON.parse(text).output;
    expect(output).toEqual([
      expect.objectContaining({ type: "function_call", namespace: "mcp__cua_repl", name: "js", call_id: "call_0", arguments: '{"code":"1+1"}' }),
      expect.objectContaining({ type: "custom_tool_call", namespace: "mcp__node_repl", name: "js", call_id: "call_1", input: "2+2" }),
    ]);
    if (stream) {
      for (const type of ["response.output_item.added", "response.output_item.done"]) {
        expect(events.filter(event => event.type === type).map(event => [event.item.namespace, event.item.name]))
          .toEqual([["mcp__cua_repl", "js"], ["mcp__node_repl", "js"]]);
      }
    }
    const sent = executeMock.mock.calls[0][0].body;
    expect(sent.tools.map(tool => tool.function.name)).toEqual(["mcp__cua_repl__js", "mcp__node_repl__js"]);
    expect(sent._toolNameMap).toBeUndefined();
    const continuation = await route({ tools, stream: false,
      tool_choice: { type: "custom", namespace: "mcp__node_repl", name: "js" },
      input: [...input, ...output,
        { type: "function_call_output", call_id: "call_0", output: "2" },
        { type: "custom_tool_call_output", call_id: "call_1", output: "4" },
      ],
    });
    await continuation.response.text();
    const next = executeMock.mock.calls.at(-1)[0].body;
    expect(next.tool_choice.function.name).toBe("mcp__node_repl__js");
    expect(next.messages.flatMap(message => message.tool_calls || []).map(call => [call.id, call.function.name]))
      .toEqual([["call_0", "mcp__cua_repl__js"], ["call_1", "mcp__node_repl__js"]]);
    expect(next.messages.filter(message => message.role === "tool").map(message => [message.tool_call_id, message.content]))
      .toEqual([["call_0", "2"], ["call_1", "4"]]);
  });

  it("restores aliased custom tools in native JSON responses", () => {
    const response = { choices: [{ message: { tool_calls: [
      { id: "call_browser", function: { name: "browser__js", arguments: '{"code":"1+1"}' } },
      { id: "call_node", function: { name: "node__js", arguments: '{"input":"2+2"}' } },
    ] }, finish_reason: "tool_calls" }] };
    const out = translateNonStreamingResponse(response, "openai", "openai-responses", new Set(["node__js"]), new Map([["browser__js", "browser"], ["node__js", "node"]]));
    const restored = restoreToolNames(out, new Map([["browser__js", "js"], ["node__js", "js"]]));
    expect(restored.output).toEqual([
      expect.objectContaining({ type: "function_call", namespace: "browser", name: "js", call_id: "call_browser", arguments: '{"code":"1+1"}' }),
      expect.objectContaining({ type: "custom_tool_call", namespace: "node", name: "js", call_id: "call_node", input: "2+2" }),
    ]);
  });

  it("forwards a Codex screenshot as an image instead of base64 tool text", async () => {
    const image = "data:image/png;base64,iVBORw0KGgo=";
    const result = await route({ stream: false, reasoning: { effort: "max" }, tools: [namespace], input: [
      { role: "user", content: "Inspect the generated page." },
      { type: "custom_tool_call", call_id: "screenshot", namespace: "functions", name: "exec", input: "image(await tools.view_image({path: 'preview.png'}));" },
      { type: "custom_tool_call_output", call_id: "screenshot", output: [
        { type: "input_text", text: "Script completed" },
        { type: "input_image", image_url: image },
      ] },
    ] });
    await result.response.text();
    const body = executeMock.mock.calls[0][0].body;
    expect(body.reasoning_effort).toBe("max");
    expect(body.messages.find(message => message.role === "tool")).toEqual({
      role: "tool", tool_call_id: "screenshot", content: "Script completed",
    });
    expect(body.messages.at(-1)).toMatchObject({ role: "user", content: [
      { type: "text", text: "[Image from tool result screenshot]" },
      { type: "image_url", image_url: { url: image } },
    ] });
  });

  it("recovers namespaces from custom and function call history", () => {
    expect(collectResponsesToolNamespaces({ input: [
      { type: "custom_tool_call", namespace: "functions", name: "exec" },
      { type: "function_call", namespace: "functions", name: "wait" },
    ] })).toEqual(new Map([["exec", "functions"], ["wait", "functions"]]));
  });
});
