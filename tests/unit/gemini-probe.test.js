import { describe, expect, it } from "vitest";
import { describeGeminiProbeError } from "@/lib/geminiProbe";

describe("Gemini model availability evidence", () => {
  it("keeps a local cooldown from inheriting a different model's failure", () => {
    const result = describeGeminiProbeError(404, "Another model is no longer available to new users", "router");
    expect(result.testStatus).toBe("retry");
    expect(result.error).not.toContain("Another model");
  });
  it("distinguishes a zero limit, temporary rate pressure, and a high-demand model", () => {
    const probe = (status, msg) => describeGeminiProbeError(status, msg, "upstream");
    expect(probe(429, "Quota exceeded for metric: free_tier, limit: 0, model: example").testStatus).toBe("error");
    expect(probe(429, JSON.stringify({ error: { message: "Quota exceeded", details: [{ violations: [{ quotaValue: "0" }] }] } })).testStatus).toBe("error");
    expect(probe(429, "Quota exceeded for metric: free_tier, limit: 20, model: example").testStatus).toBe("retry");
    expect(probe(503, "This model is currently experiencing high demand.").testStatus).toBe("retry");
    expect(probe(404, '[404]: {"error":{"message":"This model is no longer available to new users"}}\n提示：error')).toMatchObject({
      testStatus: "error", source: "upstream", error: expect.stringContaining("Google 已停止向新用户提供此模型"),
    });
    expect(probe(403, "Invalid credential AQ.private_example_token").error).not.toContain("private_example_token");
  });
});
