import "open-sse/index.js";
import { getApiKeyByValue, getSettings } from "@/lib/localDb";
import { getRequestTokenEstimates } from "@/lib/requestCaller.js";
import { estimateInputTokenBreakdown } from "open-sse/utils/usageTracking.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import { extractApiKey, isValidApiKey } from "./auth.js";
import { acquireConcurrencySlot, ConcurrencyQueueError } from "../services/concurrencyLimiter.js";
import { extractClientIp } from "../utils/clientIp.js";
import { readChatRequestBody } from "../utils/requestBody.js";
import * as log from "../utils/logger.js";
import { getRequestId, rejectChatRequest, resolveRequestProviderScope } from "./requestContext.js";
import { handleSingleModelChat } from "./modelRouting.js";

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  const requestId = getRequestId(request);
  const callerApiKey = extractApiKey(request);
  let requestBody = clientRawRequest?.body || null;
  if (!requestBody) {
    try { requestBody = await request.clone().json(); } catch { requestBody = null; }
  }
  const requestContext = {
    ...(clientRawRequest || {}),
    endpoint: clientRawRequest?.endpoint || (() => {
      try { return new URL(request.url).pathname; } catch { return null; }
    })(),
    body: requestBody,
    requestedServiceTier: typeof requestBody?.service_tier === "string" ? requestBody.service_tier : "unspecified",
    requestId,
    startedAt: Date.now(),
    requestBytes: requestBody ? Buffer.byteLength(JSON.stringify(requestBody), "utf8") : null,
    ...(requestBody ? estimateInputTokenBreakdown(requestBody) : getRequestTokenEstimates()),
    stream: requestBody ? requestBody.stream !== false : null,
    apiKeyName: callerApiKey ? "未命名 API Key" : "未使用 API Key",
    apiKeyRecordId: null,
    apiKeyMasked: callerApiKey ? log.maskKey(callerApiKey) : null,
    headers: clientRawRequest?.headers || Object.fromEntries(request.headers.entries()),
    clientIp: clientRawRequest?.clientIp || extractClientIp(request),
  };
  let admissionPermit = null;
  const releaseAdmission = () => {
    admissionPermit?.release();
    admissionPermit = null;
  };
  try {
    // Admission is FIFO per provider and only covers API Key resolution before
    // the provider/account work begins. It must not be held during upstream
    // work, otherwise a per-provider limit of 1 serializes every request and
    // prevents account concurrency limits from ever filling up.
    const providerScope = await resolveRequestProviderScope(request);
    try {
      admissionPermit = await acquireConcurrencySlot({
        scope: "providerAdmission",
        id: providerScope,
        limit: 1,
        signal: request.signal,
        requestId,
        hideFromSnapshot: true,
      });
    } catch (error) {
      if (error instanceof ConcurrencyQueueError) return rejectChatRequest(error.status, error.message, { ...requestContext, ...error.requestContext }, "router");
      throw error;
    }

    try {
      const apiKey = callerApiKey;
      if (apiKey) {
        const record = await getApiKeyByValue(apiKey);
        requestContext.apiKeyName = record?.name || "未命名 API Key";
        requestContext.apiKeyMasked = log.maskKey(apiKey);
        requestContext.apiKeyRecordId = record?.id || null;
        requestContext.apiKeyLimit = record?.isActive
          ? (Number(record.maxConcurrentRequests) || 0)
          : 0;

        if (!record?.isActive || requestContext.apiKeyLimit === 0) {
          log.debug("LIMITER", `Bypass API Key limit for ${record?.id || "unknown"} (inactive or unlimited)`);
        }
      }
    } finally {
      releaseAdmission();
    }

    const response = await handleChatInternal(request, requestContext);
    return response;
  } catch (error) {
    throw error;
  } finally {
    releaseAdmission();
  }
}

async function handleChatInternal(request, clientRawRequest = null) {
  let body;
  try {
    body = await readChatRequestBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid JSON body");
  } catch (error) {
    if (error.status === HTTP_STATUS.PAYLOAD_TOO_LARGE || error.status === HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE) {
      return rejectChatRequest(error.status, error.message, clientRawRequest);
    }
    log.warn("CHAT", "Invalid JSON body");
    return rejectChatRequest(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body", clientRawRequest);
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries()),
      clientIp: extractClientIp(request)
    };
  } else if (!clientRawRequest.clientIp) {
    clientRawRequest.clientIp = extractClientIp(request);
  }
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;
  clientRawRequest.modelContextMarker = contextMarker;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return rejectChatRequest(HTTP_STATUS.UNAUTHORIZED, "Missing API key", clientRawRequest);
    }
    const valid = await isValidApiKey(apiKey, request);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return rejectChatRequest(HTTP_STATUS.UNAUTHORIZED, "Invalid API key", clientRawRequest);
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return rejectChatRequest(HTTP_STATUS.BAD_REQUEST, "Missing model", clientRawRequest);
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey);
}
