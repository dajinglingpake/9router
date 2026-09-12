import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormat, getTargetFormat, resolveTransport } from "open-sse/services/provider.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import { extractThinking } from "open-sse/translator/concerns/thinkingUnified.js";
import { getModelTargetFormat, getModelSupportedFormats, getModelUpstreamId, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import * as log from "../utils/logger.js";
import { extractClientIp } from "../utils/clientIp.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import { getApiKeyByValue, getProviderConnectionById, getProviderConnections } from "@/lib/localDb";
import { isModelLockActive } from "open-sse/services/accountFallback.js";
import { resolveProviderId } from "@/shared/constants/providers.js";
import {
  acquireConcurrencySlot,
  holdConcurrencyUntilResponseDone,
  ConcurrencyQueueError,
  getConcurrencySnapshot,
} from "../services/concurrencyLimiter.js";

const requestIds = new WeakMap();

function getRequestId(request) {
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

function buildConcurrencyMetadata({ body, clientRawRequest, request, provider, model, credentials = null, apiKey = null, providerThinking = null }) {
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
    endpoint,
    requestedModel,
    upstreamModel: model ? getModelUpstreamId(alias, model) : null,
    thinkingLevel,
    sourceFormat,
    targetFormat,
    requestBytes,
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

async function resolveRequestProviderScope(request) {
  try {
    const body = await request.clone().json();
    return resolveProviderScope(body?.model);
  } catch {
    return "unknown";
  }
}

async function getProviderCapacityState(provider) {
  const providerId = resolveProviderId(provider);
  const connections = await getProviderConnections({ provider: providerId, isActive: true });
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

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  const requestId = getRequestId(request);
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
      if (error instanceof ConcurrencyQueueError) return errorResponse(error.status, error.message);
      throw error;
    }

    try {
      const apiKey = extractApiKey(request);
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
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
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
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey, request);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings)
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey);
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null) {
  const requestId = getRequestId(request);
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
          adapterAdded
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        // Preserve a real upstream rate-limit status so clients can honor
        // Retry-After instead of seeing a generic 503 and retrying too soon.
        const lastErrorStatus = Number(credentials.lastErrorCode || lastStatus);
        const status = lastErrorStatus === HTTP_STATUS.RATE_LIMITED
          ? HTTP_STATUS.RATE_LIMITED
          : HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    // A provider selector must honor exclusions. Guard against a selector
    // returning the same connection again (notably virtual no-auth accounts),
    // which would otherwise turn fallback/queue failures into an infinite loop.
    if (excludeConnectionIds.has(credentials.connectionId)) {
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const concurrencyMetadata = buildConcurrencyMetadata({
      body,
      clientRawRequest,
      request,
      provider,
      model,
      credentials: refreshedCredentials,
      apiKey,
      providerThinking,
    });
    const apiKeyRecordId = clientRawRequest?.apiKeyRecordId || null;
    const apiKeyLimit = Number(clientRawRequest?.apiKeyLimit) || 0;
    let apiKeyPermit = null;

    // API Key limits are a backstop, not a hard admission gate. Let requests
    // fill the account slots first; only once this provider's account slots are
    // all occupied do we throttle the caller by API Key before it can queue for
    // an account.
    if (apiKeyRecordId && apiKeyLimit > 0) {
      const providerCapacity = await getProviderCapacityState(provider);
      if (providerCapacity.full) {
        try {
          apiKeyPermit = await acquireConcurrencySlot({
            scope: "apiKey",
            id: apiKeyRecordId,
            limit: apiKeyLimit,
            signal: request?.signal,
            requestId,
            metadata: {
              providerScope: provider,
              ...concurrencyMetadata,
            },
          });
        } catch (error) {
          if (error instanceof ConcurrencyQueueError) return errorResponse(error.status, error.message);
          throw error;
        }
      }
    }

    let accountPermit;
    try {
      accountPermit = await acquireConcurrencySlot({
        scope: "account",
        id: credentials.connectionId,
        limit: credentials.maxConcurrency,
        signal: request?.signal,
        requestId,
        metadata: {
          providerScope: provider,
          ...concurrencyMetadata,
        },
      });
    } catch (error) {
      apiKeyPermit?.release();
      if (error instanceof ConcurrencyQueueError) {
        // A queue timeout is a capacity failure for this request, not an
        // upstream account error. Return immediately instead of waiting on
        // every account in sequence.
        return errorResponse(error.status, error.message);
      }
      throw error;
    }

    // A queued request may acquire the slot after an earlier request locked
    // this account; re-check persisted state before sending upstream traffic.
    const liveConnection = credentials.connectionId === "noauth"
      ? credentials
      : await getProviderConnectionById(credentials.connectionId);
    if (!liveConnection || !liveConnection.isActive || isModelLockActive(liveConnection, model)) {
      accountPermit.release();
      apiKeyPermit?.release();
      excludeConnectionIds.add(credentials.connectionId);
      continue;
    }

    let result;
    try {
      result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      headroomTimeoutMs: chatSettings.headroomTimeoutMs,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        // "Consecutive" strikes: a success clears the breaker for this pair.
        clearAntigravityStrikes(credentials.connectionId, model);
      }
      });
    } catch (error) {
      accountPermit.release();
      apiKeyPermit?.release();
      throw error;
    }

    if (result.success) {
      return holdConcurrencyUntilResponseDone(result.response, () => {
        accountPermit.release();
        apiKeyPermit?.release();
      });
    }

    // Apply fallback/cooldown state before releasing the slot so queued work
    // observes the latest account availability.

    // Antigravity 409/429: refresh live quota to get exact resetAt before locking
    let quotaResetMs = null;
    let resetsAtMs = result.resetsAtMs;
    if (provider === "antigravity" && (result.status === 409 || result.status === 429)) {
      quotaResetMs = await handleAntigravityQuotaError(
        credentials.connectionId, result.status, model,
        refreshedCredentials.accessToken, credentials.providerSpecificData
      );
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }

    // Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
    // Do not persist a modelLock_* for this path.
    const shouldFallback = provider === "antigravity" && quotaResetMs
      ? true
      : (await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, resetsAtMs)).shouldFallback;

    if (shouldFallback) {
      accountPermit.release();
      apiKeyPermit?.release();
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    accountPermit.release();
    apiKeyPermit?.release();
    return result.response;
  }
}
