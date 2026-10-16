import { describe, expect, it } from "vitest";
import { CodeBuddyExecutor } from "../../open-sse/executors/codebuddy-cn.js";

describe("CodeBuddy preserves application system instructions", () => {
  const executor = new CodeBuddyExecutor();
  const followUps = '<!-- ai-capability-follow-ups {"items":["next request"]} -->';

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
});
