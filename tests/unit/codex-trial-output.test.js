import { describe, expect, it } from "vitest";
import { formatTrialErrorLog } from "@/shared/utils/codexTrialOutput.js";

describe("CLI error details", () => {
  it("shows retries and failures without commands or generated output, merging repeated messages", () => {
    const log = [
      { type: "error", message: "Reconnecting 1/5: server_is_overloaded" },
      { type: "error", message: "Reconnecting 2/5: server_is_overloaded" },
      { type: "item.completed", item: { type: "agent_message", text: "generated HTML" } },
      { type: "item.completed", item: { type: "command_execution", command: "private command", aggregated_output: "large output", exit_code: 0 } },
      { type: "item.completed", item: { type: "error", message: "tool failed" } },
      { type: "turn.failed", error: { message: "final failure" } },
    ].map(JSON.stringify).join("\n");
    expect(formatTrialErrorLog(log, "final failure")).toBe("[错误] Reconnecting 1/5: server_is_overloaded\n\n[错误] Reconnecting 2/5: server_is_overloaded\n\n[错误] tool failed\n\n[错误] final failure");
  });
  it("uses the saved process error when no structured error event survived", () => {
    expect(formatTrialErrorLog("truncated JSON\nplain stderr\n", "CLI unavailable")).toBe("[错误] CLI unavailable");
    expect(formatTrialErrorLog("not JSON")).toBe("");
    expect(formatTrialErrorLog()).toBe("");
  });
});
