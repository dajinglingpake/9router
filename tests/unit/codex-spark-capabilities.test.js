import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

describe("Codex Spark capabilities", () => {
  it("reports Spark variants with their 128k context window", () => {
    expect(getCapabilitiesForModel("codex", "gpt-5.3-codex-spark").contextWindow).toBe(128000);
    expect(getCapabilitiesForModel("codex", "gpt-5.3-codex-spark-review").contextWindow).toBe(128000);
    expect(getCapabilitiesForModel("cx", "gpt-5.3-codex-spark-high").contextWindow).toBe(128000);
  });
});
