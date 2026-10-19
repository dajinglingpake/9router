import { describe, expect, it } from "vitest";
import { matchesTrialDegradationRule } from "@/shared/utils/codexTrialQuality.js";

const sample = (changes = {}) => ({ status: "success", hasHtml: true, htmlLines: 350,
  tokensPerSecond: 30, usage: { output_tokens: 10000 }, ...changes });

describe("Codex trial sample degradation rule", () => {
  it("includes all three exact upper bounds and previously saved successful samples", () => {
    expect(matchesTrialDegradationRule(sample())).toBe(true);
    expect(matchesTrialDegradationRule(sample({ htmlLines: 204, tokensPerSecond: 19.9, usage: { output_tokens: 5831 } }))).toBe(true);
  });
  it.each([{ htmlLines: 351 }, { tokensPerSecond: 30.01 }, { usage: { output_tokens: 10001 } }])("requires every threshold, using the unrounded rate: %j", changes => {
    expect(matchesTrialDegradationRule(sample(changes))).toBe(false);
  });
  it.each(["queued", "running", "error", "cancelled", "interrupted"])("does not label %s records even if old metrics are present", status => {
    expect(matchesTrialDegradationRule(sample({ status }))).toBe(false);
  });
  it.each([{ hasHtml: false }, { htmlLines: null }, { htmlLines: 0 }, { tokensPerSecond: null },
    { tokensPerSecond: NaN }, { tokensPerSecond: Infinity }, { tokensPerSecond: -1 }, { tokensPerSecond: "20" },
    { usage: null }, { usage: {} }, { usage: { output_tokens: -1 } }, { usage: { output_tokens: "1000" } }])("does not treat missing or invalid metrics as low measurements: %j", changes => {
    expect(matchesTrialDegradationRule(sample(changes))).toBe(false);
  });
  it("evaluates each model result independently and clears the mark after a replacement result", () => {
    const results = [sample({ model: "first" }), sample({ model: "second", htmlLines: 500 }), null];
    expect(results.map(matchesTrialDegradationRule)).toEqual([true, false, false]);
    results[0] = sample({ tokensPerSecond: 40 });
    expect(results.map(matchesTrialDegradationRule)).toEqual([false, false, false]);
  });
});
