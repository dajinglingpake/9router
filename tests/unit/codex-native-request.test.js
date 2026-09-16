import { describe, expect, it } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { CODEX_DEFAULT_INSTRUCTIONS } from "../../open-sse/config/codexInstructions.js";

const user = { role: "user", content: "Reply OK" };
function transform(extra = {}) {
  return new CodexExecutor().transformRequest("gpt-5.6-sol", {
    model: "gpt-5.6-sol", input: [user], ...extra,
  }, true, { connectionId: "native-request", providerSpecificData: {} });
}

describe("native Codex request semantics", () => {
  it.each([false, true])("preserves explicit parallel_tool_calls=%s", parallel_tool_calls => {
    expect(transform({ parallel_tool_calls }).parallel_tool_calls).toBe(parallel_tool_calls);
  });

  it("does not add a parallel tool setting when absent", () => {
    expect(transform()).not.toHaveProperty("parallel_tool_calls");
  });

  it.each(["developer", "system"])("does not duplicate %s instructions carried in input", role => {
    const result = transform({ input: [
      { type: "additional_tools", role: "developer", tools: [{ type: "namespace", name: "tools", tools: [] }] },
      { type: "message", role, content: [{ type: "input_text", text: "Client instructions" }] },
      user,
    ] });
    expect(result).not.toHaveProperty("instructions");
    expect(result.input[1].content[0].text).toBe("Client instructions");
    expect(result.input[0].tools[0].type).toBe("namespace");
  });

  it("preserves string developer messages and explicit top-level instructions", () => {
    const input = [{ role: "developer", content: "Client instructions" }, user];
    expect(transform({ input })).not.toHaveProperty("instructions");
    expect(transform({ input, instructions: "Explicit instructions" }).instructions).toBe("Explicit instructions");
  });

  it("retains the fallback for requests without actual instructions", () => {
    expect(transform().instructions).toBe(CODEX_DEFAULT_INSTRUCTIONS);
    expect(transform({ input: [
      { type: "additional_tools", role: "developer", tools: [] },
      { role: "developer", content: "  " }, user,
    ] }).instructions).toBe(CODEX_DEFAULT_INSTRUCTIONS);
  });
});
