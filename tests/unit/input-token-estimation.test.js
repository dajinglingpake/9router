import { describe, expect, it } from "vitest";
import { estimateInputTokens, estimateInputTokenBreakdown, estimateUsage } from "../../open-sse/utils/usageTracking.js";

const opaque = "A".repeat(4_000_000);
const text = { type: "input_text", text: "Explain this code." };

describe("visible input token estimation", () => {
  it("separates text, readable attachments, unknown media and encrypted context", () => {
    const request = { messages: [{ role: "user", content: [
      { type: "text", text: "hello" },
      { type: "document", source: { type: "text", data: "text".repeat(100) } },
      { type: "image", source: { type: "base64", data: opaque } },
      { type: "redacted_thinking", data: opaque },
    ] }] };
    const estimate = estimateInputTokenBreakdown(request);
    expect(estimate).toMatchObject({
      estimatedAttachmentTokens: 100, attachmentCount: 2, unestimatedAttachmentCount: 1,
      encryptedContextCount: 1, inputTokenEstimateVersion: 2,
    });
    expect(estimate.estimatedInputTokens).toBeLessThan(50);
    expect(estimateInputTokens(request)).toBe(estimate.estimatedInputTokens + 100);
    expect(estimateInputTokenBreakdown({ input: "hello" })).toMatchObject({ estimatedAttachmentTokens: 0, attachmentCount: 0, unestimatedAttachmentCount: 0, encryptedContextCount: 0 });
  });
  it("ignores multi-megabyte image and encrypted payloads while preserving Responses text", () => {
    const base = { instructions: "You are helpful.", input: [{ role: "user", content: [text] }] };
    const request = {
      ...base,
      input: [
        { role: "user", content: [text, { type: "input_image", image_url: `data:image/png;base64,${opaque}` }] },
        { type: "reasoning", summary: [], encrypted_content: opaque },
      ],
      metadata: { trace: opaque },
    };
    const before = JSON.stringify(request);
    expect(estimateInputTokens(request)).toBeLessThan(estimateInputTokens(base) + 30);
    expect(JSON.stringify(request)).toBe(before);
  });

  it.each([
    { type: "image_url", image_url: { url: `data:image/png;base64,${opaque}` } },
    { type: "input_audio", input_audio: { data: opaque, format: "wav" } },
    { type: "file", file: { file_data: opaque } },
    { type: "image", source: { type: "base64", data: opaque, media_type: "image/png" } },
    { type: "document", source: { type: "base64", data: opaque } },
    { type: "redacted_thinking", data: opaque },
  ])("does not turn $type payload bytes into text tokens", block => {
    const base = { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] };
    const request = structuredClone(base);
    request.messages[0].content.push(block);
    expect(estimateInputTokens(request)).toBe(estimateInputTokens(base));
  });

  it("handles Gemini wrappers and opaque part fields", () => {
    const base = { contents: [{ role: "user", parts: [{ text: "Explain" }] }] };
    const wrapped = { project: opaque, request: { contents: [{ role: "user", parts: [
      { text: "Explain", thoughtSignature: opaque }, { inlineData: { data: opaque, mimeType: "image/png" } },
    ] }] } };
    expect(estimateInputTokens(wrapped)).toBeLessThan(estimateInputTokens(base) + 5);
  });

  it("retains tool schemas, arguments, results and readable thinking", () => {
    const request = { system: "Follow instructions.", tools: [{ name: "read", input_schema: {
      type: "object", properties: { file_data: { type: "string", description: "file text ".repeat(100) } },
    } }], messages: [{ role: "assistant", content: [
      { type: "thinking", thinking: "Think carefully.", signature: opaque },
      { type: "tool_use", name: "read", input: { file_data: "readable ".repeat(100) } },
      { type: "tool_result", content: "tool output ".repeat(100) },
    ] }] };
    expect(estimateInputTokens(request)).toBeGreaterThan(700);
    expect(estimateInputTokens(request)).toBeLessThan(1500);
    expect(estimateUsage(request, 100).estimated).toBe(true);
  });

  it("counts plain-text documents and structured tool arguments without stripping user field names", () => {
    const document = { messages: [{ role: "user", content: [{ type: "document", source: { type: "text", data: "file text ".repeat(200) } }] }] };
    expect(estimateInputTokens(document)).toBeGreaterThan(400);
    const call = { contents: [{ parts: [{ functionCall: { name: "read", args: { file_data: "tool data ".repeat(200) } } }] }] };
    expect(estimateInputTokens(call)).toBeGreaterThan(400);
  });

  it("ignores generation settings and handles absent or invalid input", () => {
    const prompt = { input: "hello" };
    expect(estimateInputTokens({ ...prompt, model: "any-model", max_output_tokens: 100000, metadata: { debug: opaque } })).toBe(estimateInputTokens(prompt));
    for (const value of [undefined, null, {}, { model: "any-model" }]) expect(estimateInputTokens(value)).toBe(0);
    const cyclic = { messages: [] }; cyclic.messages.push(cyclic);
    expect(estimateInputTokens(cyclic)).toBe(0);
  });
});
