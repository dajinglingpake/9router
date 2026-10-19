import { getProviderConnections } from "@/lib/localDb";
import { appendRequestLog } from "@/lib/usageDb.js";
import { getRequestCaller, getRequestLogContext, getRequestTokenEstimates } from "@/lib/requestCaller.js";
import { estimateInputTokenBreakdown } from "open-sse/utils/usageTracking.js";
import { errorResponse } from "open-sse/utils/error.js";
import { detectFormat, getTargetFormat, resolveTransport } from "open-sse/services/provider.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import { extractThinking } from "open-sse/translator/concerns/thinkingUnified.js";
import { getModelTargetFormat, getModelSupportedFormats, getModelUpstreamId, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import { resolveProviderId } from "@/shared/constants/providers.js";
import { getModelInfo, getComboModels } from "../services/model.js";
import { getConcurrencySnapshot } from "../services/concurrencyLimiter.js";
import { extractClientIp } from "../utils/clientIp.js";
import { filterAccountPoolForRequest } from "../services/accountApiKeyAccess.js";
import { appendChatErrorHint } from "../utils/errorHints.js";
import * as log from "../utils/logger.js";

const requestIds = new WeakMap();

export function rejectChatRequest(status, message, context, source = "client", extraHeaders = null, hintOptions = {}) {
  appendRequestLog({
    ...getRequestLogContext(context),
    requestId: context?.requestId || null,
    status: `FAILED ${status}`, message, source,
    model: context?.routingModel || (typeof context?.body?.model === "string" ? context.body.model : null),
    provider: context?.provider || null, connectionId: context?.connectionId || null, retryCount: context?.retryCount || 0,
    endpoint: context?.endpoint || null,
  }).catch(() => {});
  return errorResponse(status, appendChatErrorHint(status, message, { ...hintOptions, source, networkCode: context?.networkCode }), extraHeaders);
}

export function getRequestId(request) {
  if (!request || (typeof request !== "object" && typeof request !== "function")) return null;
  if (requestIds.has(request)) return requestIds.get(request);
  const id = request.headers.get("x-request-id") || globalThis.crypto?.randomUUID?.() || `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  requestIds.set(request, id);
  return id;
}

function thinkingLevelFromConfig(config) {
  if (!config) return null;
  if (config.mode === "level") return config.level || null;
  if (config.mode === "budget") return Number.isFinite(config.budget) ? `budget:${config.budget}` : null;
  return config.mode || null;
}

export function buildConcurrencyMetadata({ body, clientRawRequest, request, provider, model, credentials = null, apiKey = null, providerThinking = null }) {
  const rawBody = body && typeof body === "object" ? body : {};
  const endpoint = clientRawRequest?.endpoint || (() => {
    try { return new URL(request?.url || "").pathname || null; } catch { return null; }
  })();
  const sourceFormat = detectFormatByEndpoint(endpoint || "", rawBody) || detectFormat(rawBody);
  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  const runtimeTransport = resolveTransport(provider, sourceFormat);
  const supportedFormats = getModelSupportedFormats(alias, model);
  const useTransport = (!supportedFormats || supportedFormats.includes(sourceFormat)) ? runtimeTransport : null;
  const targetFormat = useTransport?.format
    || getModelTargetFormat(alias, model)
    || getTargetFormat(provider, credentials);
  const requestedModel = typeof rawBody.model === "string" && rawBody.model.trim()
    ? rawBody.model.trim()
    : (model ? `${provider}/${model}` : null);
  const thinkingLevel = thinkingLevelFromConfig(extractThinking(rawBody) || providerThinking);
  const requestBytes = Buffer.byteLength(JSON.stringify(rawBody), "utf8");

  return {
    apiKeyName: clientRawRequest?.apiKeyName || (apiKey ? "未命名 API Key" : "未使用 API Key"),
    apiKeyMasked: clientRawRequest?.apiKeyMasked || (apiKey ? log.maskKey(apiKey) : null),
    clientIp: clientRawRequest?.clientIp || extractClientIp(request),
    userAgent: getRequestCaller(clientRawRequest || { headers: request?.headers }).userAgent,
    endpoint,
    requestedModel,
    routingModel: model,
    upstreamModel: model ? getModelUpstreamId(alias, model) : null,
    thinkingLevel: thinkingLevel || "auto",
    requestedServiceTier: clientRawRequest?.requestedServiceTier || (typeof rawBody.service_tier === "string" ? rawBody.service_tier : "unspecified"),
    upstreamServiceTier: clientRawRequest?.upstreamServiceTier || null,
    sourceFormat,
    targetFormat,
    requestBytes,
    ...(clientRawRequest?.inputTokenEstimateVersion ? getRequestTokenEstimates(clientRawRequest) : estimateInputTokenBreakdown(rawBody)),
    stream: rawBody.stream !== false,
  };
}

async function resolveProviderScope(model, seen = new Set()) {
  const normalizedModel = typeof model === "string" ? model.trim() : "";
  if (!normalizedModel || seen.has(normalizedModel)) return normalizedModel || "unknown";
  seen.add(normalizedModel);

  const info = await getModelInfo(normalizedModel);
  if (info?.provider) return info.provider;

  const comboModels = await getComboModels(normalizedModel);
  if (!comboModels?.length) return `model:${normalizedModel}`;

  const providers = new Set();
  for (const comboModel of comboModels) {
    providers.add(await resolveProviderScope(comboModel, seen));
  }
  return [...providers].sort().join(",") || `model:${normalizedModel}`;
}

export async function resolveRequestProviderScope(request) {
  try {
    const body = await request.clone().json();
    return resolveProviderScope(body?.model);
  } catch {
    return "unknown";
  }
}

export async function getProviderCapacityState(provider, request = null) {
  const providerId = resolveProviderId(provider);
  const connections = (await filterAccountPoolForRequest(
    await getProviderConnections({ provider: providerId }), request
  )).filter(c => c.isActive !== false);
  const connectionIds = new Set(connections.map((connection) => connection.id));
  const accountLimits = connections.map((connection) => Number(connection.maxConcurrency) || 0);
  const totalLimit = accountLimits.reduce((sum, limit) => sum + limit, 0);
  const hasUnlimitedAccount = accountLimits.some((limit) => limit === 0);
  const active = getConcurrencySnapshot()
    .filter((item) => item.scope === "account" && connectionIds.has(item.id))
    .reduce((sum, item) => sum + (Number(item.active) || 0), 0);

  return {
    totalLimit,
    active,
    hasUnlimitedAccount,
    full: !hasUnlimitedAccount && totalLimit > 0 && active >= totalLimit,
  };
}
