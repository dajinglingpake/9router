export const CODEX_TRIAL_DEGRADATION_LIMITS = {
  htmlLines: 350,
  tokensPerSecond: 30,
  outputTokens: 10000,
};

// A sample-level user rule, independent of manually maintained account labels.
export function matchesTrialDegradationRule(result) {
  if (result?.status !== "success" || result.hasHtml !== true) return false;
  const { htmlLines, tokensPerSecond, usage } = result;
  const outputTokens = usage?.output_tokens;
  return Number.isInteger(htmlLines) && htmlLines > 0 && htmlLines <= CODEX_TRIAL_DEGRADATION_LIMITS.htmlLines
    && typeof tokensPerSecond === "number" && Number.isFinite(tokensPerSecond)
    && tokensPerSecond >= 0 && tokensPerSecond <= CODEX_TRIAL_DEGRADATION_LIMITS.tokensPerSecond
    && Number.isInteger(outputTokens) && outputTokens >= 0 && outputTokens <= CODEX_TRIAL_DEGRADATION_LIMITS.outputTokens;
}
