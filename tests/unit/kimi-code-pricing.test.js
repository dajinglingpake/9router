import { describe, expect, it } from "vitest";
import { calculateCostFromTokens, getPricingForModel } from "../../open-sse/providers/pricing.js";
import { extractUsage } from "../../open-sse/utils/usageTracking.js";

describe("Kimi Code cost estimates", () => {
  it.each(["k3.1-pro", "kimi/k3.1-pro", "kimi-k3.1-pro"])("prices %s with the official standard rate", model => {
    const pricing = getPricingForModel("kimi", model);
    expect(pricing).toMatchObject({ input: 2, output: 10, cached: 0.2, cache_creation: 2 });
    // A real stored Kimi request: the 303 reasoning tokens are part of 490 output tokens.
    expect(calculateCostFromTokens({
      prompt_tokens: 12495, cached_tokens: 8448, completion_tokens: 490,
      reasoning_tokens: 303, completion_tokens_details: { reasoning_tokens: 303 },
    }, pricing)).toBeCloseTo(0.0146836, 10);
  });

  it.each(["k3.1-pro-highspeed", "kimi/k3.1-pro-highspeed", "kimi-k3.1-pro-highspeed"])("keeps the cache-hit price unchanged for %s", model => {
    const pricing = getPricingForModel("kimi", model);
    expect(pricing).toMatchObject({ input: 4, output: 20, cached: 0.2, cache_creation: 4 });
    expect(calculateCostFromTokens({
      prompt_tokens: 1000, cached_tokens: 600, cache_creation_input_tokens: 100,
      completion_tokens: 100,
    }, pricing)).toBeCloseTo(0.00372, 10);
  });

  it("resolves the smaller K3 context variant", () => {
    expect(getPricingForModel("kimi", "k3-256k")).toEqual(getPricingForModel("kimi", "k3"));
  });

  it("handles Responses reasoning details without requiring duplicated top-level fields", () => {
    expect(calculateCostFromTokens({
      input_tokens: 100, output_tokens: 50, output_tokens_details: { reasoning_tokens: 30 },
    }, getPricingForModel("kimi", "k3.1-pro"))).toBeCloseTo(0.0007, 10);
  });

  it("preserves the reasoning subset through streaming and nonstreaming usage extraction", async () => {
    const { extractUsageFromResponse } = await import("../../open-sse/handlers/chatCore/requestDetail.js");
    const response = { usage: {
      input_tokens: 100, output_tokens: 50, output_tokens_details: { reasoning_tokens: 30 },
    } };
    const chatResponse = { usage: {
      prompt_tokens: 100, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 30 },
    } };
    for (const tokens of [
      extractUsage({ type: "response.completed", response }),
      extractUsageFromResponse(response),
      extractUsage(chatResponse),
      extractUsageFromResponse(chatResponse),
    ]) {
      expect(calculateCostFromTokens(tokens, getPricingForModel("kimi", "k3.1-pro"))).toBeCloseTo(0.0007, 10);
    }
  });

  it("still charges separate reasoning tokens when output does not include them", () => {
    expect(calculateCostFromTokens({
      prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 30,
    }, { input: 2, output: 10, reasoning: 10 })).toBeCloseTo(0.001, 10);
  });
});
