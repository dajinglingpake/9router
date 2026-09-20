import { safeDiagnosticMessage } from "open-sse/utils/upstreamDiagnostics.js";
import { canonicalizeUsage } from "open-sse/utils/usageTracking.js";
import { TOKEN_ESTIMATE_FIELDS } from "open-sse/config/tokenEstimation.js";

const text = (value, max = 256) => typeof value === "string" ? value.trim().slice(0, max) || null : null;

// Snapshot only display-safe caller fields. Never copy raw keys, headers or bodies.
export function getRequestCaller(context = {}) {
  context ||= {};
  const userAgent = text(context.userAgent || (typeof context.headers?.get === "function"
    ? context.headers.get("user-agent") : context.headers?.["user-agent"]), 512);
  return {
    apiKeyId: text(context.apiKeyRecordId || context.apiKeyId),
    apiKeyName: text(context.apiKeyName),
    apiKeyMasked: text(context.apiKeyMasked),
    clientIp: text(context.clientIp, 128),
    userAgent: userAgent ? safeDiagnosticMessage(userAgent) : null,
    requestedModel: text(context.requestedModel || context.body?.model),
  };
}

const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export function getRequestTokenEstimates(context = {}) {
  return Object.fromEntries(TOKEN_ESTIMATE_FIELDS.map(key => [key, number(context?.[key])]));
}

// Keep provider-reported usage separate from local estimates and missing usage.
export function getRequestTokenUsage(usage) {
  if (!usage || usage.estimated) return { inputTokens: null, outputTokens: null };
  const input = number(usage.prompt_tokens ?? usage.input_tokens);
  return {
    inputTokens: input === null ? null : number(canonicalizeUsage(usage)?.prompt_tokens),
    outputTokens: number(usage.completion_tokens ?? usage.output_tokens),
  };
}

// Capture the same fields shown for active/queued requests at the time of failure.
export function getRequestLogContext(context = {}, now = Date.now()) {
  context ||= {};
  const startedAt = number(context.startedAt);
  const usage = getRequestTokenUsage(context.tokens);
  return {
    ...getRequestCaller(context),
    upstreamModel: text(context.upstreamModel),
    requestedServiceTier: text(context.requestedServiceTier),
    upstreamServiceTier: text(context.upstreamServiceTier),
    thinkingLevel: text(context.thinkingLevel),
    sourceFormat: text(context.sourceFormat),
    targetFormat: text(context.targetFormat),
    requestTag: text(context.requestTag),
    state: text(context.state),
    stream: typeof context.stream === "boolean" ? context.stream : null,
    requestBytes: number(context.requestBytes),
    ...getRequestTokenEstimates(context),
    inputTokens: number(context.inputTokens) ?? usage.inputTokens,
    outputTokens: number(context.outputTokens) ?? usage.outputTokens,
    startedAt,
    latencyMs: number(context.latencyMs) ?? (startedAt === null ? null : Math.max(0, now - startedAt)),
    queuedAt: number(context.queuedAt),
    waitMs: number(context.waitMs),
    position: number(context.position),
    cooldownRemainingMs: number(context.cooldownRemainingMs),
    timeoutRemainingMs: number(context.timeoutRemainingMs) ?? (number(context.deadline) === null ? null : Math.max(0, context.deadline - now)),
    proxyConfigured: typeof context.proxyConfigured === "boolean" ? context.proxyConfigured : null,
    proxyPoolId: text(context.proxyPoolId, 128),
    networkCode: text(context.networkCode, 64),
  };
}
