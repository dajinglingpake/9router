import { describe, expect, it } from "vitest";
import { getTrialDegradationMetrics, matchesTrialDegradationRule } from "@/shared/utils/codexTrialQuality.js";

const sample = (changes = {}) => ({ status: "success", hasHtml: true, htmlLines: 350,
  tokensPerSecond: 30, usage: { output_tokens: 10000 }, ...changes });

describe("Codex trial sample degradation rule", () => {
  it("uses strict lower thresholds and applies to previously saved successful samples", () => {
    expect(matchesTrialDegradationRule(sample())).toBe(false);
    expect(matchesTrialDegradationRule(sample({ htmlLines: 204, tokensPerSecond: 19.9, usage: { output_tokens: 5831 } }))).toBe(true);
  });
  it.each([
    [{ htmlLines: 349, tokensPerSecond: 40, usage: { output_tokens: 12000 } }, "htmlLines"],
    [{ htmlLines: 500, tokensPerSecond: 29.999, usage: { output_tokens: 12000 } }, "tokensPerSecond"],
    [{ htmlLines: 500, tokensPerSecond: 40, usage: { output_tokens: 9999 } }, "outputTokens"],
  ])("matches any one lower metric and highlights only that metric: %j", (changes, metric) => {
    expect(matchesTrialDegradationRule(sample(changes))).toBe(true);
    expect(getTrialDegradationMetrics(sample(changes))).toEqual([metric]);
  });
  it("does not label samples when all metrics equal or exceed their thresholds", () => {
    expect(getTrialDegradationMetrics(sample())).toEqual([]);
    expect(matchesTrialDegradationRule(sample({ htmlLines: 500, tokensPerSecond: 40, usage: { output_tokens: 12000 } }))).toBe(false);
  });
  it("reports every matching metric, including the screenshot's sample with more than 10,000 output tokens", () => {
    expect(getTrialDegradationMetrics(sample({ htmlLines: 257, tokensPerSecond: 19.996, usage: { output_tokens: 10185 } })))
      .toEqual(["htmlLines", "tokensPerSecond"]);
  });
  it.each(["queued", "running", "error", "cancelled", "interrupted"])("does not label %s records even if old metrics are present", status => {
    expect(matchesTrialDegradationRule(sample({ status, htmlLines: 200, tokensPerSecond: 20, usage: { output_tokens: 1000 } }))).toBe(false);
  });
  it.each([{ hasHtml: false, htmlLines: 200 }, { htmlLines: null }, { htmlLines: 0 }, { htmlLines: -1 }, { htmlLines: "200" }, { tokensPerSecond: null },
    { tokensPerSecond: NaN }, { tokensPerSecond: Infinity }, { tokensPerSecond: -1 }, { tokensPerSecond: "20" },
    { usage: null }, { usage: {} }, { usage: { output_tokens: -1 } }, { usage: { output_tokens: "1000" } }])("does not treat missing or invalid metrics as low measurements: %j", changes => {
    expect(matchesTrialDegradationRule(sample(changes))).toBe(false);
  });
  it.each([
    { htmlLines: 349, tokensPerSecond: null, usage: null },
    { htmlLines: null, tokensPerSecond: 29.999, usage: {} },
    { htmlLines: 0, tokensPerSecond: Infinity, usage: { output_tokens: 9999 } },
  ])("keeps a valid lower metric even when other metrics are unavailable: %j", changes => {
    expect(matchesTrialDegradationRule(sample(changes))).toBe(true);
  });
  it("evaluates each model result independently and clears the mark after a replacement result", () => {
    const results = [sample({ model: "first", tokensPerSecond: 20 }), sample({ model: "second", htmlLines: 500 }), null];
    expect(results.map(matchesTrialDegradationRule)).toEqual([true, false, false]);
    results[0] = sample({ tokensPerSecond: 40 });
    expect(results.map(matchesTrialDegradationRule)).toEqual([false, false, false]);
  });
});
