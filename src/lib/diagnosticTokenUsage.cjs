// Select only numeric usage fields; raw token metadata must never enter a diagnostics snapshot.
const tokenFields = {
  reportedInputTokens: ["$.prompt_tokens", "$.input_tokens"],
  reportedOutputTokens: ["$.completion_tokens", "$.output_tokens"],
  reasoningTokens: ["$.reasoning_tokens", "$.completion_tokens_details.reasoning_tokens", "$.output_tokens_details.reasoning_tokens"],
};
const DIAGNOSTIC_TOKEN_COLUMNS = Object.entries(tokenFields).map(([alias, paths]) => {
  const values = paths.map(path => `CASE WHEN json_type(tokens, '${path}') IN ('integer', 'real') THEN json_extract(tokens, '${path}') END`);
  return `CASE WHEN json_valid(tokens) THEN COALESCE(${values.join(", ")}) END AS ${alias}`;
}).concat("CASE WHEN json_valid(tokens) THEN CASE WHEN json_type(tokens, '$.estimated') = 'true' THEN 1 WHEN json_type(tokens, '$.estimated') = 'false' THEN 0 END END AS tokenCountsEstimated").join(",\n");

const validTokenNumber = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
function extractDiagnosticTokenUsage(row) {
  const legacyPositive = value => validTokenNumber(value) > 0 ? value : null;
  const inputTokens = validTokenNumber(row.reportedInputTokens) ?? legacyPositive(row.promptTokens);
  const outputTokens = validTokenNumber(row.reportedOutputTokens) ?? legacyPositive(row.completionTokens);
  const rawReasoning = validTokenNumber(row.reasoningTokens);
  const openAIUsage = ["codex", "openai"].includes(row.provider);
  const reasoningTokens = openAIUsage && outputTokens !== null && rawReasoning > outputTokens ? null : rawReasoning;
  const canSeparateReasoning = openAIUsage && reasoningTokens !== null && outputTokens !== null;
  return { inputTokens, outputTokens, reasoningTokens,
    nonReasoningTokens: canSeparateReasoning ? outputTokens - reasoningTokens : null,
    tokenCountsEstimated: row.tokenCountsEstimated === true || row.tokenCountsEstimated === 1 ? true
      : row.tokenCountsEstimated === false || row.tokenCountsEstimated === 0 ? false : null };
}

module.exports = { DIAGNOSTIC_TOKEN_COLUMNS, extractDiagnosticTokenUsage };
