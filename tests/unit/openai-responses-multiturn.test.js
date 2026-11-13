/**
 * Multi-turn continuity for store=false Responses backends (Grok CLI / Codex).
 * Prior-turn reasoning (+ encrypted_content) must survive Chat Completions ↔ Responses.
 */
import { describe, it, expect } from "vitest";
import {
  openaiToOpenAIResponsesRequest,
  openaiResponsesToOpenAIRequest,
} from "../../open-sse/translator/request/openai-responses.js";
import { GrokCliExecutor, _resetGrokCliTurnStore } from "../../open-sse/executors/grok-cli.js";
import { translateRequest } from "../../open-sse/translator/index.js";

describe("openai ↔ responses multi-turn reasoning", () => {
  it("openai→responses re-emits reasoning item with summary + encrypted_content", () => {
    const body = {
      model: "grok-4.5",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "hello",
          reasoning_content: "thinking hard about greeting",
          encrypted_content: "enc_blob_turn1",
        },
        { role: "user", content: "next" },
      ],
    };

    const out = openaiToOpenAIResponsesRequest("grok-4.5", body, true, null);
    expect(out.store).toBe(false);

    const reasoning = out.input.filter((i) => i.type === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0].encrypted_content).toBe("enc_blob_turn1");
    expect(reasoning[0].summary?.[0]?.text).toMatch(/thinking hard/);

    // Order: user → reasoning → assistant → user
    const types = out.input.map((i) => i.type || i.role);
    expect(types).toEqual(["message", "reasoning", "message", "message"]);
    expect(out.input[0].role).toBe("user");
    expect(out.input[2].role).toBe("assistant");
    expect(out.input[3].role).toBe("user");
  });

  it("accepts reasoning_encrypted_content alias on assistant messages", () => {
    const out = openaiToOpenAIResponsesRequest(
      "m",
      {
        messages: [
          {
            role: "assistant",
            content: "ok",
            reasoning_encrypted_content: "alt_enc",
          },
        ],
      },
      true,
      null
    );
    expect(out.input.find((i) => i.type === "reasoning")?.encrypted_content).toBe("alt_enc");
  });

  it("responses→openai attaches reasoning_content + encrypted_content to assistant", () => {
    const body = {
      model: "grok-4.5",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "plan A" }],
          encrypted_content: "enc_xyz",
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hello" }],
        },
      ],
    };

    const out = openaiResponsesToOpenAIRequest("grok-4.5", body, true, null);
    const assistant = out.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeTruthy();
    expect(assistant.reasoning_content).toBe("plan A");
    expect(assistant.encrypted_content).toBe("enc_xyz");
  });

  it("round-trips encrypted_content through openai → responses → openai", () => {
    const original = {
      model: "grok-4.5",
      messages: [
        { role: "user", content: "q1" },
        {
          role: "assistant",
          content: "a1",
          reasoning_content: "r1",
          encrypted_content: "ENC_KEEP_ME",
        },
        { role: "user", content: "q2" },
      ],
    };

    const responses = openaiToOpenAIResponsesRequest("grok-4.5", structuredClone(original), true, null);
    const back = openaiResponsesToOpenAIRequest("grok-4.5", responses, true, null);
    const again = openaiToOpenAIResponsesRequest("grok-4.5", back, true, null);

    const enc = again.input.find((i) => i.type === "reasoning")?.encrypted_content;
    expect(enc).toBe("ENC_KEEP_ME");
  });

  it("translateRequest openai→openai-responses preserves encrypted blob", () => {
    const body = {
      model: "grok-4.5",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "yo",
          reasoning_content: "why",
          encrypted_content: "blob_via_registry",
        },
        { role: "user", content: "go" },
      ],
    };
    const out = translateRequest(
      "openai",
      "openai-responses",
      "grok-4.5",
      structuredClone(body),
      true,
      {},
      "grok-cli"
    );
    expect(out.input.some((i) => i.type === "reasoning" && i.encrypted_content === "blob_via_registry")).toBe(
      true
    );
  });
});

describe("responses → openai assistant turn boundaries", () => {
  it.each([
    { preamble: null, postamble: "Inspecting screenshots.", expected: "Inspecting screenshots." },
    { preamble: "Before.", postamble: "After.", expected: "Before.\nAfter." },
    { preamble: [{ type: "output_text", text: "Before." }], postamble: "After.", expected: [{ type: "text", text: "Before." }, { type: "text", text: "After." }] },
    { preamble: "Before.", postamble: [{ type: "output_text", text: "After." }], expected: [{ type: "text", text: "Before." }, { type: "text", text: "After." }] },
    { preamble: "Before.", postamble: null, expected: "Before." },
  ])("keeps assistant text after calls in the same tool turn: $preamble / $postamble", ({ preamble, postamble, expected }) => {
    const input = [
      { role: "user", content: "Inspect the screenshots." },
      ...(preamble ? [{ role: "assistant", content: preamble }] : []),
      { type: "function_call", name: "view_image", call_id: "view_image:27", arguments: "{}" },
      { type: "reasoning", summary: [{ text: "Inspect all images." }], encrypted_content: "enc_after_call" },
      { role: "assistant", phase: "commentary", content: postamble },
      { type: "custom_tool_call", name: "exec", call_id: "exec:28", input: "inspect" },
      { type: "function_call_output", call_id: "view_image:27", output: "image inspected" },
      { type: "custom_tool_call_output", call_id: "exec:28", output: "done" },
      { role: "assistant", content: "Finished." },
    ];
    const original = structuredClone(input);
    const out = openaiResponsesToOpenAIRequest("m", { input }, true, null);

    expect(out.messages.map(message => message.role)).toEqual(["user", "assistant", "tool", "tool", "assistant"]);
    expect(out.messages[1]).toMatchObject({ content: expected, reasoning_content: "Inspect all images.", encrypted_content: "enc_after_call" });
    expect(out.messages[1].tool_calls.map(call => call.id)).toEqual(["view_image:27", "exec:28"]);
    expect(out.messages[4].content).toBe("Finished.");
    expect(input).toEqual(original);
  });

  it.each([undefined, "commentary"])("keeps a preamble and parallel tools in one turn (phase=%s)", (phase) => {
    const out = openaiResponsesToOpenAIRequest("m", { input: [
      { role: "user", content: "Run the checks." },
      { type: "reasoning", summary: [{ text: "Inspect first." }], encrypted_content: "enc_before" },
      { type: "message", role: "assistant", phase, content: [{ type: "output_text", text: "Checking now." }] },
      { type: "reasoning", summary: [{ text: "Run both checks." }], encrypted_content: "enc_after" },
      { type: "function_call", name: "check", call_id: "call_check", arguments: '{"path":"a"}' },
      { type: "custom_tool_call", name: "exec", call_id: "call_exec", input: "run checks" },
      { type: "function_call_output", call_id: "call_check", output: "ok" },
      { type: "custom_tool_call_output", call_id: "call_exec", output: "passed" },
      { type: "message", role: "assistant", content: "All checks passed." },
    ] }, true, null);

    expect(out.messages).toEqual([
      { role: "user", content: "Run the checks." },
      {
        role: "assistant", content: [{ type: "text", text: "Checking now." }],
        reasoning_content: "Inspect first.\nRun both checks.", encrypted_content: "enc_after",
        tool_calls: [
          { id: "call_check", type: "function", function: { name: "check", arguments: '{"path":"a"}' } },
          { id: "call_exec", type: "function", function: { name: "exec", arguments: '{"input":"run checks"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_check", content: "ok" },
      { role: "tool", tool_call_id: "call_exec", content: "passed" },
      { role: "assistant", content: "All checks passed." },
    ]);
  });

  it("does not merge tools across user messages or tool outputs", () => {
    const out = openaiResponsesToOpenAIRequest("m", { input: [
      { role: "assistant", content: "Which file?" },
      { role: "user", content: "a.txt" },
      { type: "function_call", name: "read", call_id: "read_a", arguments: "{}" },
      { type: "function_call_output", call_id: "read_a", output: "contents" },
      { type: "function_call", name: "check", call_id: "check_a", arguments: "{}" },
      { type: "function_call_output", call_id: "check_a", output: "ok" },
      { role: "assistant", content: "Done." },
    ] }, true, null);

    expect(out.messages.map(message => message.role)).toEqual([
      "assistant", "user", "assistant", "tool", "assistant", "tool", "assistant",
    ]);
    expect(out.messages[0]).toEqual({ role: "assistant", content: "Which file?" });
    expect(out.messages[2].tool_calls.map(tool => tool.id)).toEqual(["read_a"]);
    expect(out.messages[4].tool_calls.map(tool => tool.id)).toEqual(["check_a"]);
    expect(out.messages[6]).toEqual({ role: "assistant", content: "Done." });
  });
});

describe("GrokCliExecutor multi-turn input", () => {
  it("keeps native Grok reasoning and item ids", () => {
    _resetGrokCliTurnStore();
    const executor = new GrokCliExecutor();
    const body = {
      model: "grok-4.5",
      input: [
        { type: "message", role: "system", content: "You are Grok" },
        { type: "message", role: "user", content: "hi", id: "msg_3e3f6187-892a-96db-893b-904eff019e19" },
        {
          type: "reasoning",
          id: "rs_3e3f6187-892a-96db-893b-904eff019e19",
          summary: [{ type: "summary_text", text: "prior plan" }],
          encrypted_content: "enc_from_cli",
        },
        { type: "message", role: "assistant", content: "hello", id: "msg_4e3f6187-892a-96db-893b-904eff019e19" },
        { type: "message", role: "user", content: "again" },
      ],
      include: ["reasoning.encrypted_content"],
    };

    const out = executor.transformRequest("grok-4.5", structuredClone(body), true, {
      connectionId: "mt-1",
    });

    const reasoning = out.input.filter((i) => i.type === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0].encrypted_content).toBe("enc_from_cli");
    expect(reasoning[0].summary?.[0]?.text).toBe("prior plan");
    expect(reasoning[0].id).toBe("rs_3e3f6187-892a-96db-893b-904eff019e19");

    // system preserved (not developer)
    expect(out.input[0].role).toBe("system");
    // Native Grok IDs are required for encrypted continuity.
    for (const item of out.input) {
      if (item.type === "message" && item.id) expect(item.id).toMatch(/^msg_[0-9a-f-]{36}$/);
    }
    expect(out.include).toContain("reasoning.encrypted_content");
    expect(out.store).toBe(false);
    expect(executor._currentTurnIdx).toBe(2);
  });
});
