import { describe, expect, it } from "vitest";
import { openaiResponsesToOpenAIRequest } from "../../open-sse/translator/request/openai-responses.js";

const image = "data:image/png;base64,iVBORw0KGgo=";
const convert = input => openaiResponsesToOpenAIRequest("deepseek-v4.1-flash", { input }, true, {});

describe("Responses tool output images", () => {
  it.each(["function", "custom_tool"])("keeps a %s screenshot out of the tool text", kind => {
    const input = [
      { type: `${kind}_call`, name: "view_image", call_id: "shot", arguments: "{}", input: "view screenshot" },
      { type: `${kind}_call_output`, call_id: "shot", output: [
        { type: "input_text", text: "Screenshot captured." },
        { type: "input_image", image_url: image, detail: "high" },
      ] },
    ];
    const original = structuredClone(input);
    const out = convert(input);
    expect(out.messages.slice(1)).toEqual([
      { role: "tool", tool_call_id: "shot", content: "Screenshot captured." },
      { role: "user", content: [
        { type: "text", text: "[Image from tool result shot]" },
        { type: "image_url", image_url: { url: image, detail: "high" } },
      ] },
    ]);
    expect(input).toEqual(original);
  });

  it("places images after parallel results and before the next assistant turn", () => {
    const out = convert([
      { type: "function_call", name: "view_image", call_id: "shot", arguments: "{}" },
      { type: "function_call", name: "read_file", call_id: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "shot", output: [{ type: "input_image", image_url: image }] },
      { type: "function_call_output", call_id: "read", output: [{ type: "input_text", text: "file contents" }] },
      { type: "reasoning", summary: [{ text: "Inspect the screenshot." }] },
      { role: "assistant", content: "Looks correct." },
    ]);
    expect(out.messages.map(message => message.role)).toEqual(["assistant", "tool", "tool", "user", "assistant"]);
    expect(out.messages[1]).toMatchObject({ tool_call_id: "shot", content: "" });
    expect(out.messages[2]).toMatchObject({ tool_call_id: "read", content: "file contents" });
    expect(out.messages[3].content[1]).toEqual({ type: "image_url", image_url: { url: image, detail: "auto" } });
    expect(out.messages[4]).toMatchObject({ content: "Looks correct.", reasoning_content: "Inspect the screenshot." });
  });

  it.each([
    { type: "reasoning", summary: [{ text: "Inspect all screenshots." }] },
    { type: "additional_tools", tools: [{ type: "function", name: "inspect", parameters: { type: "object" } }] },
  ])("keeps parallel image results together across $type items", metadata => {
    const ids = ["view_image:27", "view_image:28", "view_image:29"];
    const out = convert([
      ...ids.map(call_id => ({ type: "function_call", name: "view_image", call_id, arguments: "{}" })),
      { type: "function_call_output", call_id: ids[0], output: [{ type: "input_image", image_url: image }] },
      metadata,
      ...ids.slice(1).map(call_id => ({ type: "function_call_output", call_id, output: [{ type: "input_image", image_url: image }] })),
      { role: "assistant", content: "All screenshots inspected." },
    ]);

    expect(out.messages.map(message => message.role)).toEqual(["assistant", "tool", "tool", "tool", "user", "assistant"]);
    expect(out.messages[0].tool_calls.map(call => call.id)).toEqual(ids);
    expect(out.messages.slice(1, 4).map(message => message.tool_call_id)).toEqual(ids);
    expect(out.messages[4].content.filter(part => part.type === "image_url")).toHaveLength(3);
    if (metadata.type === "reasoning") expect(out.messages[5].reasoning_content).toBe("Inspect all screenshots.");
    if (metadata.type === "additional_tools") expect(out.tools[0].function.name).toBe("inspect");
  });

  it("preserves plain strings and structured non-image results", () => {
    const out = convert([
      { type: "function_call_output", call_id: "text", output: "unchanged" },
      { type: "function_call_output", call_id: "json", output: { ok: true } },
      { type: "function_call_output", call_id: "array", output: [{ type: "input_text", text: "first" }, { type: "input_text", text: "second" }] },
    ]);
    expect(out.messages.map(message => message.content)).toEqual(["unchanged", '{"ok":true}', "first\nsecond"]);
    expect(out.messages.every(message => message.role === "tool")).toBe(true);
  });
});
