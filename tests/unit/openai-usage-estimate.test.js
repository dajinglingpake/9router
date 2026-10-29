import { describe, expect, it } from "vitest";
import { estimateOpenAIUsage } from "@/lib/openaiUsageEstimate.js";

const row = {
  model: "gpt-6.1-sol", service_tier: "default", batch: false,
  num_model_requests: 1, input_tokens: 1_000_000, output_tokens: 100_000,
  input_cached_tokens: 200_000, input_cache_write_tokens: 400_000,
  input_cache_write_30m_tokens: 300_000, input_cache_write_12h_tokens: 100_000,
};

describe("OpenAI monetary usage estimate", () => {
  it("counts cached input and both cache-write durations once, and aggregates daily rows", () => {
    const result = estimateOpenAIUsage([row, row]);
    // Each day: 0.4M * $2 + 0.2M * $0.1 + 0.3M * $2.5 + 0.1M * $5 + 0.1M * $10.
    expect(result.amount).toBeCloseTo(6.14);
    expect(result.unpricedRequests).toBe(0);
    expect(result.breakdown).toHaveLength(1);
    expect(result.breakdown[0].requests).toBe(2);
    expect(result.breakdown[0].components.reduce((total, part) => total + part.amount, 0)).toBeCloseTo(result.amount);
  });

  it.each([["default", false, 1], ["flex", false, 0.5], ["default", true, 0.5], ["flex", true, 0.5], ["priority", false, 2], ["fast", false, 2], ["ultrafast", false, 6]])("prices %s / batch %s once", (service_tier, batch, multiplier) => {
    expect(estimateOpenAIUsage([{ ...row, service_tier, batch }]).amount).toBeCloseTo(3.07 * multiplier);
  });

  it("uses only exact verified models or their dated snapshots", () => {
    expect(estimateOpenAIUsage([{ ...row, model: "gpt-6.1-terra-2026-10-01" }]).amount).toBeCloseTo(1.535);
    expect(estimateOpenAIUsage([{ ...row, model: "gpt-6.1-sol-new" }])).toMatchObject({ amount: null, unpricedRequests: 1 });
  });

  it.each([
    { model: "unknown-model" }, { service_tier: "auto" }, { service_tier: null },
    { input_audio_tokens: 1 }, { input_image_tokens: 1 }, { output_audio_tokens: 1 },
    { input_cached_tokens: 2_000_000 }, { input_cached_tokens: "200000" },
    { input_cache_write_30m_tokens: 5 }, { input_cache_write_12h_tokens: 500_000 },
    { model: "gpt-6.1-terra", service_tier: "ultrafast" },
  ])("marks unsupported pricing or inconsistent usage as partial: %j", overrides => {
    const result = estimateOpenAIUsage([row, { ...row, ...overrides, num_model_requests: 2 }]);
    expect(result.amount).toBeCloseTo(3.07);
    expect(result.unpricedRequests).toBe(2);
  });

  it("does not invent a zero estimate when all requests are unpriced", () => {
    expect(estimateOpenAIUsage([{ ...row, model: "unknown" }])).toMatchObject({ amount: null, unpricedRequests: 1, breakdown: [] });
    expect(estimateOpenAIUsage([])).toMatchObject({ amount: 0, unpricedRequests: 0, breakdown: [] });
  });

  it("supports cache-write subtotals when the combined write count is absent", () => {
    expect(estimateOpenAIUsage([{ ...row, input_cache_write_tokens: undefined }]).amount).toBeCloseTo(3.07);
  });
});
