// Offline routing matrix for the Kimi Code /responses transport.
//
// Drives the REAL handleChatCore guard + targetFormat resolution; only the executor's HTTP
// response is mocked. The assertion target is credentials.runtimeTransport — the field
// DefaultExecutor.buildUrl/buildHeaders read — so a wrong routing decision shows up as the
// wrong baseUrl here, same as on the wire. Executor-level cells check URL and auth
// without any network.
import { describe, it, expect, vi, beforeEach } from "vitest";
import "../translator/registerAll.js";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", async (importOriginal) => ({
  ...await importOriginal(),
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("uuid", () => ({
  v4: () => "00000000-0000-4000-8000-000000000000",
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

// image.js imports Agent from "undici" (not installed in some dev envs); the
// prefetch path is irrelevant to routing assertions.
vi.mock("../../open-sse/translator/concerns/image.js", () => ({
  encodeDataUri: (mimeType, base64) => `data:${mimeType};base64,${base64}`,
  parseDataUri: (url) => {
    const m = /^data:([^;]+);base64,(.*)$/.exec(url);
    return m ? { mimeType: m[1], base64: m[2] } : null;
  },
  fetchImageAsBase64: async () => null,
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { DefaultExecutor } = await import("../../open-sse/executors/default.js");

const { resolveTransport } = await import("../../open-sse/services/provider.js");
const { PROVIDERS } = await import("../../open-sse/config/providers.js");
const { getProviderModels } = await import("../../open-sse/config/providerModels.js");

// Everything below derives from the registry: no model id or host is hardcoded.
const MODELS = getProviderModels("kimi").map((m) => m.id);
const transportFor = (format) => PROVIDERS.kimi.transports.find((t) => t.format === format);
const urlOf = (t) => (t.urlSuffix ? `${t.baseUrl}${t.urlSuffix}` : t.baseUrl);

const RESPONSE_BY_FORMAT = {
  claude: {
    id: "msg_1", type: "message", role: "assistant", model: "test",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
  openai: {
    id: "chatcmpl-1", object: "chat.completion", model: "test",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
  "openai-responses": {
    id: "resp_1", object: "response", created_at: 0, status: "completed", model: "test",
    output: [{
      type: "message", id: "msg_1", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    }],
  },
};

async function route(model, sourceFormat, overrides = {}, upstreamResponse = null) {
  executeMock.mockImplementationOnce(async ({ credentials }) => {
    const rt = credentials.runtimeTransport;
    const format = rt?.format || "claude";
    return {
      response: upstreamResponse || new Response(JSON.stringify(RESPONSE_BY_FORMAT[format] || RESPONSE_BY_FORMAT.claude), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      url: rt ? urlOf(rt) : urlOf(transportFor("claude")),
      headers: {},
      transformedBody: null,
    };
  });

  const body = sourceFormat === "openai-responses"
    ? { model: `kimi/${model}`, stream: false, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] }
    : sourceFormat === "claude"
      ? { model: `kimi/${model}`, stream: false, max_tokens: 16, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }
      : { model: `kimi/${model}`, stream: false, max_tokens: 16, messages: [{ role: "user", content: "hi" }] };

  const credentials = { apiKey: "test-key", providerSpecificData: {} };
  const result = await handleChatCore({
    body: { ...body, ...overrides },
    modelInfo: { provider: "kimi", model },
    credentials,
    connectionId: "kimi-route-test",
    sourceFormatOverride: sourceFormat,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
  });

  const { credentials: creds, body: translatedBody } = executeMock.mock.calls.at(-1)[0];
  const executorResult = await executeMock.mock.results.at(-1).value;
  return { result, translatedBody, runtimeTransport: creds.runtimeTransport ?? null, effectiveUrl: executorResult.url };
}

describe("kimi /responses transport routing (via real handleChatCore)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("declares an openai-responses transport on the Kimi Code host", () => {
    const rt = transportFor("openai-responses");
    expect(rt).toBeDefined();
    expect(new URL(rt.baseUrl).origin).toBe(new URL(PROVIDERS.kimi.baseUrl).origin);
    expect(new URL(rt.baseUrl).pathname.endsWith("/responses")).toBe(true);
  });

  it("registry exposes models to exercise", () => {
    expect(MODELS.length).toBeGreaterThan(0);
  });

  it.each([
    { tools: [{ type: "custom", name: "exec" }] },
    { input: [{ type: "additional_tools", tools: [{ type: "custom", name: "exec" }] }, { role: "user", content: "hi" }] },
    { tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }] },
  ])("routes unsupported custom declarations through Chat and preserves exec: %j", async (overrides) => {
    const { result, runtimeTransport, translatedBody } = await route(MODELS[0], "openai-responses", overrides);
    expect(result.success).toBe(true);
    expect(runtimeTransport?.format).toBe("openai");
    expect(translatedBody.input).toBeUndefined();
    expect(translatedBody.tools).toEqual([expect.objectContaining({
      type: "function",
      function: expect.objectContaining({ name: "exec", parameters: expect.objectContaining({ required: ["input"] }) }),
    })]);
    expect(translatedBody._customToolNames).toBeUndefined();
  });

  it("keeps native Responses for apply_patch and function tools", async () => {
    const tools = [{ type: "custom", name: "apply_patch" }, { type: "function", name: "exec", parameters: { type: "object" } }];
    const { runtimeTransport, translatedBody } = await route(MODELS[0], "openai-responses", { tools });
    expect(runtimeTransport?.format).toBe("openai-responses");
    expect(translatedBody.tools).toEqual(tools);
  });

  it("converts custom tool history even without a fresh declaration", async () => {
    const { runtimeTransport, translatedBody } = await route(MODELS[0], "openai-responses", {
      input: [
        { type: "custom_tool_call", name: "exec", call_id: "call_exec", input: "return 1;" },
        { type: "custom_tool_call_output", call_id: "call_exec", output: "1" },
      ],
    });
    expect(runtimeTransport?.format).toBe("openai");
    expect(translatedBody.messages).toEqual([
      expect.objectContaining({ role: "assistant", tool_calls: [{ id: "call_exec", type: "function", function: { name: "exec", arguments: '{"input":"return 1;"}' } }] }),
      { role: "tool", tool_call_id: "call_exec", content: "1" },
    ]);
  });

  it.each([false, true])("returns exec in Responses custom-tool format (stream=%s)", async (stream) => {
    const toolCall = { id: "call_exec", type: "function", function: { name: "exec", arguments: '{"input":"return 1;"}' } };
    const chatResponse = stream
      ? [{ id: "chatcmpl-1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: null }] },
        { id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }]
        .map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"
      : JSON.stringify({ ...RESPONSE_BY_FORMAT.openai, choices: [{ index: 0, message: { role: "assistant", tool_calls: [toolCall] }, finish_reason: "tool_calls" }] });
    const { result, translatedBody } = await route(MODELS[0], "openai-responses", {
      stream, tools: [{ type: "custom", name: "exec" }], tool_choice: { type: "custom", name: "exec" },
    }, new Response(chatResponse, { headers: { "content-type": stream ? "text/event-stream" : "application/json" } }));
    expect(result.success).toBe(true);
    expect(translatedBody.tool_choice).toEqual({ type: "function", function: { name: "exec" } });
    const text = await result.response.text();
    const output = stream
      ? text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)))
        .find(event => event.type === "response.completed")?.response.output
      : JSON.parse(text).output;
    expect(output).toEqual(expect.arrayContaining([expect.objectContaining({
      type: "custom_tool_call", name: "exec", call_id: "call_exec", input: "return 1;",
    })]));
    if (stream) expect(text).toContain("response.custom_tool_call_input.delta");
  });

  // Registry models only; an id without declared supportedFormats uses the
  // sourceFormat-matched transport, so each must follow its client's wire format.
  for (const model of MODELS) {
    it(`routes ${model} + responses client to the Responses endpoint without translation`, async () => {
      const { result, runtimeTransport, effectiveUrl } = await route(model, "openai-responses");
      expect(result.success).toBe(true);
      expect(runtimeTransport?.format).toBe("openai-responses");
      expect(effectiveUrl).toBe(urlOf(transportFor("openai-responses")));
      expect(new URL(effectiveUrl).pathname.endsWith("/responses")).toBe(true);
    });

    it(`keeps ${model} + chat client on its chat transport`, async () => {
      const { result, runtimeTransport, effectiveUrl } = await route(model, "openai");
      expect(result.success).toBe(true);
      expect(runtimeTransport?.format).toBe("openai");
      expect(effectiveUrl).toBe(urlOf(transportFor("openai")));
    });

    it(`keeps ${model} + claude client on its messages transport`, async () => {
      const { result, runtimeTransport, effectiveUrl } = await route(model, "claude");
      expect(result.success).toBe(true);
      expect(runtimeTransport?.format).toBe("claude");
      expect(effectiveUrl).toBe(urlOf(transportFor("claude")));
    });
  }
});

describe("DefaultExecutor('kimi') on the responses transport", () => {
  const rt = () => resolveTransport("kimi", "openai-responses");

  it("is resolvable for Responses clients", () => {
    expect(rt()).toBeTruthy();
    expect(rt().format).toBe("openai-responses");
  });

  it("builds the Responses URL exactly as declared", () => {
    const ex = new DefaultExecutor("kimi");
    expect(ex.buildUrl(MODELS[0], true, 0, { runtimeTransport: rt() })).toBe(urlOf(rt()));
  });

  it("authenticates with Bearer and keeps the X-Msh-* identity headers (api key and oauth)", () => {
    const ex = new DefaultExecutor("kimi");
    const url = urlOf(rt());

    const keyHeaders = ex.buildHeaders({ apiKey: "sk-kimi-test", runtimeTransport: rt(), providerSpecificData: {} }, true, url, MODELS[0]);
    expect(keyHeaders.Authorization).toBe("Bearer sk-kimi-test");
    expect(keyHeaders["x-api-key"]).toBeUndefined();
    expect(Object.keys(keyHeaders).some((h) => h.toLowerCase().startsWith("x-msh-"))).toBe(true);

    const oauthHeaders = ex.buildHeaders({ accessToken: "tok-test", runtimeTransport: rt(), providerSpecificData: {} }, true, url, MODELS[0]);
    expect(oauthHeaders.Authorization).toBe("Bearer tok-test");
  });
});
