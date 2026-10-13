import { describe, expect, it } from "vitest";
import { getOutputThroughput, summarizeOutputThroughput } from "@/shared/utils/outputThroughput.js";
import { extractDiagnosticTokenUsage } from "@/lib/diagnosticTokenUsage.cjs";

const success = patch => ({ kind: "success", outputTokens: 100, latencyMs: 20000, ttftMs: 19999, ...patch });

describe("whole-request token throughput", () => {
  it("includes the complete logged duration instead of subtracting a near-terminal first chunk", () => {
    expect(getOutputThroughput(success({ nonReasoningTokens: 40 }))).toEqual({ totalTps: 5, nonReasoningTps: 2 });
    expect(getOutputThroughput(success({ ttftMs: null }))).toEqual({ totalTps: 5, nonReasoningTps: null });
  });
  it("computes account mean from summed tokens and durations, keeping per-request median separate", () => {
    const stats = summarizeOutputThroughput([success(), success({ outputTokens: 300, latencyMs: 1000 }),
      success({ kind: "error", outputTokens: 1000000 }), success({ kind: "cancelled", outputTokens: 1000000 })]);
    expect(stats).toMatchObject({ throughputSamples: 2, throughputOutputTokens: 400, throughputDurationMs: 21000,
      throughputP50Tps: 5, outputTokenSamples: 2, outputTokensP50: 100 });
    expect(stats.throughputMeanTps).toBeCloseTo(400 / 21);
  });
  it("rejects missing, invalid, estimated and zero-duration records without inventing zeros", () => {
    for (const patch of [{ outputTokens: null }, { outputTokens: "100" }, { outputTokens: -1 }, { outputTokens: NaN },
      { latencyMs: 0 }, { latencyMs: null }, { latencyMs: -1 }, { tokenCountsEstimated: true }]) {
      expect(getOutputThroughput(success(patch))).toBeNull();
    }
    expect(getOutputThroughput(success({ outputTokens: 0 })).totalTps).toBe(0);
    expect(summarizeOutputThroughput([success({ tokenCountsEstimated: true })])).toMatchObject({ throughputSamples: 0, throughputMeanTps: null, estimatedTokenSamples: 1 });
    expect(summarizeOutputThroughput([])).toMatchObject({ throughputMeanTps: null, throughputP50Tps: null, outputTokensP50: null, reasoningTokensP50: null });
  });
  it("computes non-reasoning throughput only on records whose reasoning split is known", () => {
    const stats = summarizeOutputThroughput([success({ outputTokens: 1000, reasoningTokens: 600, nonReasoningTokens: 400 }), success()]);
    expect(stats).toMatchObject({ throughputSamples: 2, nonReasoningThroughputSamples: 1, nonReasoningThroughputMeanTps: 20,
      reasoningTokenSamples: 1, reasoningTokensP50: 600 });
    expect(getOutputThroughput(success({ nonReasoningTokens: 101 })).nonReasoningTps).toBeNull();
  });
});

describe("safe diagnostic token extraction", () => {
  it("distinguishes an explicitly recorded zero from missing legacy default zeros", () => {
    expect(extractDiagnosticTokenUsage({ promptTokens: 0, completionTokens: 0 })).toMatchObject({ inputTokens: null, outputTokens: null, reasoningTokens: null, nonReasoningTokens: null });
    expect(extractDiagnosticTokenUsage({ provider: "codex", reportedOutputTokens: 0, reasoningTokens: 0 })).toMatchObject({ outputTokens: 0, reasoningTokens: 0, nonReasoningTokens: 0 });
    expect(extractDiagnosticTokenUsage({ completionTokens: 100 })).toMatchObject({ outputTokens: 100, nonReasoningTokens: null });
  });
  it("does not subtract reasoning for other provider conventions or inconsistent OpenAI counts", () => {
    expect(extractDiagnosticTokenUsage({ provider: "codex", reportedOutputTokens: 1000, reasoningTokens: 600 })).toMatchObject({ nonReasoningTokens: 400 });
    expect(extractDiagnosticTokenUsage({ provider: "claude", reportedOutputTokens: 1000, reasoningTokens: 1500 })).toMatchObject({ reasoningTokens: 1500, nonReasoningTokens: null });
    expect(extractDiagnosticTokenUsage({ provider: "codex", reportedOutputTokens: 1000, reasoningTokens: 1500 })).toMatchObject({ reasoningTokens: null, nonReasoningTokens: null });
    expect(extractDiagnosticTokenUsage({ provider: "codex", reportedOutputTokens: "private", reasoningTokens: "private" })).toMatchObject({ outputTokens: null, reasoningTokens: null, nonReasoningTokens: null });
  });
});
