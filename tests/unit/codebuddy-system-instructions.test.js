import { describe, expect, it } from "vitest";
import { CodeBuddyExecutor } from "../../open-sse/executors/codebuddy-cn.js";
import { openaiResponsesToOpenAIRequest } from "../../open-sse/translator/request/openai-responses.js";

describe("CodeBuddy preserves application system instructions", () => {
  const executor = new CodeBuddyExecutor();
  const followUps = '<!-- ai-capability-follow-ups {"items":["next request"]} -->';
  const textOf = (content) => typeof content === "string" ? content : content.map(block => block.text || "").join("");

  it.each([1999, 2000, 2001, 6000])("preserves a %i-character application prompt", (length) => {
    const prefix = "You are an AI capability agent embedded in a business product. ";
    const suffix = `\nAppend ${followUps} after the answer. Write suggestions from the user's perspective.`;
    const rules = "Use current tool results and respect user permissions. ".repeat(120);
    const content = prefix + rules.slice(0, length - prefix.length - suffix.length) + suffix;
    const messages = [{ role: "system", content }, { role: "user", content: "Explain this page." }];

    const result = executor.transformRequest("deepseek-v4.1-flash", { messages }, true, {});

    expect(content).toHaveLength(length);
    expect(result.messages).toEqual(messages);
    expect(result.messages[0].content).toContain(followUps);
  });

  it("preserves long typed system blocks and separate application rules", () => {
    const messages = [
      { role: "system", content: [{ type: "text", text: "Read current business data. ".repeat(100) }] },
      { role: "system", content: [{ type: "text", text: "Keep required output metadata. ".repeat(100) },
        { type: "text", text: followUps }] },
      { role: "user", content: "Explain this page." },
    ];

    const result = executor.transformRequest("deepseek-v4.1-flash", { messages }, true, {});

    expect(result.messages).toEqual(messages);
  });

  it.each([false, true])("keeps the existing CLI identity compatibility handling (typed=%s)", (typed) => {
    const identity = "You are Claude Code, Anthropic's official CLI.";
    const application = "Keep application instructions. ".repeat(100) + followUps;
    const messages = [
      { role: "system", content: typed ? [{ type: "text", text: identity }] : identity },
      { role: "system", content: application },
      { role: "user", content: "Hello" },
    ];

    const result = executor.transformRequest("deepseek-v4.1-flash", { messages }, true, {});

    expect(result.messages[0].content).toEqual(typed
      ? [{ type: "text", text: "You are a helpful AI assistant that helps with software engineering tasks." }]
      : "You are a helpful AI assistant that helps with software engineering tasks.");
    expect(result.messages.slice(1)).toEqual(messages.slice(1));
  });

  it.each(["chat", "responses"])("preserves Harness execution rules through %s", (format) => {
    const instructions = [
      "You are an AI agent powered by DeepSeek Harness.",
      "You are a coding agent powered by the cbcn/deepseek-v4.1-flash model.",
      "Read an existing file before overwriting it with write and prefer edit for targeted changes.",
      "Before giving a final answer, collect every still-relevant job and stop jobs that no longer matter.",
    ].join("\n\n");
    const user = { role: "user", content: "Create an HTML animation. Do not run any tests." };
    const body = format === "responses"
      ? openaiResponsesToOpenAIRequest("deepseek-v4.1-flash", { instructions, input: [user] }, true, {})
      : { messages: [{ role: "system", content: instructions }, user] };

    const result = executor.transformRequest("deepseek-v4.1-flash", body, true, {});

    const forwarded = textOf(result.messages[0].content);
    expect(forwarded.startsWith("You are a helpful AI assistant that helps with software engineering tasks.")).toBe(true);
    expect(forwarded.endsWith(instructions.slice(instructions.indexOf("Read an existing file")))).toBe(true);
    expect(result.messages[1]).toEqual(user);
  });

  it.each([false, true])("retains rules in the same block as a CLI identity (typed=%s)", (typed) => {
    const rules = " Read tool results before continuing.\nWhen the requested file is written, return its path.";
    const text = "You are Claude Code, Anthropic's official CLI." + rules;
    const content = typed ? [
      { type: "text", text, cache_control: { type: "ephemeral" } },
      { type: "text", text: "Respect the user's request not to run tests." },
    ] : text;
    const original = structuredClone(content);

    const result = executor.transformRequest("deepseek-v4.1-flash", {
      messages: [{ role: "system", content }],
    }, true, {});

    const expected = "You are a helpful AI assistant that helps with software engineering tasks." + rules;
    expect(textOf(result.messages[0].content)).toBe(expected + (typed ? original[1].text : ""));
    if (typed) {
      const cacheBlocks = result.messages[0].content.filter(block => block.cache_control);
      expect(cacheBlocks).toHaveLength(1);
      expect(cacheBlocks[0].cache_control).toEqual(original[0].cache_control);
      expect(cacheBlocks[0].text.endsWith("return its path.")).toBe(true);
      expect(result.messages[0].content.at(-1)).toEqual(original[1]);
    }
    expect(content).toEqual(original);
  });

  it("does not discard rules that mention another agent or use role tags", () => {
    const content = '<Role>Document integration behavior.</Role>\n<Behavior_Instructions>\nIf logs say "You are Claude Code", quote that identity accurately.\n</Behavior_Instructions>';
    const result = executor.transformRequest("deepseek-v4.1-flash", {
      messages: [{ role: "system", content }],
    }, true, {});

    expect(textOf(result.messages[0].content)).toBe(content);
  });

  it("preserves whitespace and code identifiers while separating GUI context sentences", () => {
    const rules = 'Use the current GUI.\r\nDo not start another server. The entry point is window.__DSH_BOOT__.\nKeep version v4.1 and path /apps/web unchanged.';
    const content = `<Role>Follow client rules.</Role>\n${rules}`;
    const result = executor.transformRequest("deepseek-v4.1-flash", {
      messages: [{ role: "system", content }],
    }, true, {});

    expect(result.messages[0].content.length).toBeGreaterThan(1);
    expect(textOf(result.messages[0].content)).toBe(content);
  });

  it("does not treat an execution rule in the introduction as disposable identity", () => {
    const content = "You are an AI agent powered by Example and must stop after writing the requested file. Do not run tests.";
    const result = executor.transformRequest("deepseek-v4.1-flash", {
      messages: [{ role: "system", content }],
    }, true, {});

    expect(textOf(result.messages[0].content)).toBe(content);
  });
});
