import { describe, expect, it } from "vitest";
import { createTrialOutputFormatter, formatTrialErrorLog, formatTrialLog } from "@/shared/utils/codexTrialOutput.js";

describe("CLI error details", () => {
  it("keeps the custom-model metadata fallback visible as a warning without reporting a failed request", () => {
    const event = {
      type: "item.completed",
      item: { id: "item_0", type: "error", message: "Model metadata for `space-bunny` not found. Defaulting to fallback metadata; this can degrade performance and cause issues." },
    };
    const log = JSON.stringify(event);
    expect(createTrialOutputFormatter()(event)).toMatchObject({ warning: true, activity: "使用默认模型元数据继续运行" });
    expect(formatTrialLog(log)).toContain("[警告] Codex CLI 未内置模型 space-bunny 的元数据");
    expect(formatTrialErrorLog(log)).toBe("");
    expect(formatTrialErrorLog(log, "request failed")).toBe("[错误] request failed");
  });
  it("does not suppress other missing-model or metadata failures", () => {
    const log = [
      { type: "error", message: "Model space-bunny not found" },
      { type: "item.completed", item: { type: "error", message: "Model metadata could not be loaded" } },
    ].map(JSON.stringify).join("\n");
    expect(formatTrialErrorLog(log)).toBe("[错误] Model space-bunny not found\n\n[错误] Model metadata could not be loaded");
  });
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
