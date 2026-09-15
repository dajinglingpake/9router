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
import { appendRequestLog } from "@/lib/usageDb.js";
import { getSessionRoutingKey, NEW_SESSION_HINT } from "../services/sessionRouting.js";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse } from "open-sse/utils/error.js";
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
import { isModelLockActive, getModelLockUntil } from "open-sse/services/accountFallback.js";
import { resolveProviderId } from "@/shared/constants/providers.js";
import {
  acquireConcurrencySlot,
  holdConcurrencyUntilResponseDone,
  ConcurrencyQueueError,
  getConcurrencySnapshot,
  pauseAccountQueue,
  resumeAccountQueue,
  queueTimeoutMs,
} from "../services/concurrencyLimiter.js";

const requestIds = new WeakMap();

function rejectChatRequest(status, message, context, source = "client") {
  appendRequestLog({
    status: `FAILED ${status}`, message, source,
    model: typeof context?.body?.model === "string" ? context.body.model : null,
    endpoint: context?.endpoint || null,
  }).catch(() => {});
  return errorResponse(status, message);
}

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
    routingModel: model,
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
      if (error instanceof ConcurrencyQueueError) return rejectChatRequest(error.status, error.message, requestContext, "router");
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
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid JSON body");
  } catch {
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

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, seenModels = new Set(), excludedAccounts = new Set(), deadline = Date.now() + queueTimeoutMs(), retryCount = 0) {
  if (seenModels.has(modelStr)) return rejectChatRequest(HTTP_STATUS.BAD_REQUEST, "模型组合存在循环引用。", clientRawRequest, "router");
  seenModels.add(modelStr);
  const requestId = getRequestId(request);
  // Resolve combo aliases (including cc/<name>) before provider prefixes.
  const comboModels = await getComboModels(modelStr);
  if (comboModels?.length) {
    return handleSingleModelChat(body, comboModels[0], clientRawRequest, request, apiKey, seenModels, excludedAccounts, deadline, retryCount);
  }
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return rejectChatRequest(HTTP_STATUS.BAD_REQUEST, "Invalid model format", clientRawRequest);
  }

  const { provider, model } = modelInfo;

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  const sessionKey = getSessionRoutingKey(clientRawRequest?.headers, clientRawRequest?.body || body, clientRawRequest?.apiKeyRecordId || apiKey);
  const sessionHint = sessionKey ? ` ${NEW_SESSION_HINT}` : "";
  const credentials = await getProviderCredentials(provider, excludedAccounts, model, { sessionKey, fillFirst: true, waitForCooldown: true });
  if (!credentials || credentials.sessionUnavailable || credentials.allRateLimited) {
    const status = Number(credentials?.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
    if (!sessionKey && excludedAccounts.size > 0) return errorResponse(status, credentials?.lastError || "暂无可用账号。");
    return rejectAccountCooldown(status, credentials?.lastError || "暂无可用账号。", credentials?.retryAfter, sessionHint, clientRawRequest);
  }

  let apiKeyPermit = null;
  let accountPermit = null;
  let responseOwnsPermits = false;
  try {
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
    concurrencyMetadata.retryCount = retryCount;
    const apiKeyLimit = Number(clientRawRequest?.apiKeyLimit) || 0;

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
            deadline,
            signal: request?.signal,
            requestId,
            metadata: {
              providerScope: provider,
              ...concurrencyMetadata,
            },
          });
        } catch (error) {
          if (error instanceof ConcurrencyQueueError) return rejectChatRequest(error.status, error.message, clientRawRequest, "router");
          throw error;
        }
      }
    }

    try {
      const lockedUntil = new Date(getModelLockUntil(credentials._connection, model)).getTime();
      if (sessionKey && Number(credentials._connection?.errorCode) === 503 && lockedUntil > Date.now()) {
        pauseAccountQueue(credentials.connectionId, lockedUntil);
      }
      const accountPermitPromise = acquireConcurrencySlot({
        scope: "account",
        id: credentials.connectionId,
        limit: credentials.maxConcurrency,
        deadline,
        signal: request?.signal,
        requestId,
        metadata: {
          providerScope: provider,
          ...concurrencyMetadata,
        },
      });
      // Register the active/queued slot before releasing the selection reservation.
      credentials.releaseSelection?.();
      accountPermit = await accountPermitPromise;
    } catch (error) {
      if (error instanceof ConcurrencyQueueError) {
        // A queue timeout is a capacity failure for this request, not an
        // upstream account error. Return immediately instead of waiting on
        // every account in sequence.
        return rejectChatRequest(error.status, error.message, clientRawRequest, "router");
      }
      throw error;
    }

    // A queued request may acquire the slot after an earlier request locked
    // this account; re-check persisted state before sending upstream traffic.
    const liveConnection = credentials.connectionId === "noauth"
      ? credentials
      : await getProviderConnectionById(credentials.connectionId);
    if (!liveConnection || !liveConnection.isActive || isModelLockActive(liveConnection, model)) {
      if (!sessionKey) {
        excludedAccounts.add(credentials.connectionId);
        return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, new Set(), excludedAccounts, deadline, retryCount);
      }
      if (liveConnection?.isActive && Number(liveConnection.errorCode) === 503 && isModelLockActive(liveConnection, model)) {
        return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, new Set(), excludedAccounts, deadline, retryCount);
      }
      return rejectAccountCooldown(Number(liveConnection?.errorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE, liveConnection?.lastError || "当前会话绑定的账号暂不可用。", getModelLockUntil(liveConnection, model), sessionHint, clientRawRequest);
    }

    const attemptTimeout = new AbortController();
    const attemptTimer = sessionKey ? setTimeout(() => attemptTimeout.abort(), Math.max(0, deadline - Date.now())) : null;
    let result;
    try {
      result = await handleChatCore({
      retryCount,
      requestId,
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
      clientAbortSignal: sessionKey ? AbortSignal.any([request?.signal, attemptTimeout.signal].filter(Boolean)) : request?.signal,
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
    } finally {
      clearTimeout(attemptTimer);
    }
    if (attemptTimeout.signal.aborted && !request?.signal?.aborted) {
      await result.response?.body?.cancel().catch(() => {});
      return rejectChatRequest(503, "账号繁忙，等待重试已超过时限，请稍后重试。", clientRawRequest, "router");
    }

    if (result.success) {
      resumeAccountQueue(credentials.connectionId);
      const response = holdConcurrencyUntilResponseDone(result.response, () => {
        accountPermit.release();
        apiKeyPermit?.release();
      }, { signal: request?.signal });
      responseOwnsPermits = true;
      return response;
    }
    if (result.status === 499) return result.response;

    // Apply cooldown state before releasing the slot so queued work
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
    let shouldFallback = !!quotaResetMs;
    if (!(provider === "antigravity" && quotaResetMs)) {
      ({ shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, resetsAtMs));
    }
    if (sessionKey && result.status === HTTP_STATUS.SERVICE_UNAVAILABLE) {
      await result.response?.body?.cancel().catch(() => {});
      return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, new Set(), excludedAccounts, deadline, retryCount + 1);
    }
    if (!sessionKey && shouldFallback && credentials.connectionId !== "noauth") {
      excludedAccounts.add(credentials.connectionId);
      return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, new Set(), excludedAccounts, deadline, retryCount + 1);
    }
    const response = errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, `${result.error || "账号请求失败。"}${sessionHint}`);
    const retryAfter = result.response?.headers.get("retry-after");
    if (retryAfter) response.headers.set("Retry-After", retryAfter);
    return response;
  } catch (error) {
    if (sessionKey && Date.now() >= deadline && !request?.signal?.aborted) {
      return rejectChatRequest(503, "账号繁忙，等待重试已超过时限，请稍后重试。", clientRawRequest, "router");
    }
    const cancelled = request?.signal?.aborted || error.name === "AbortError";
    if (!cancelled) {
      await markAccountUnavailable(credentials.connectionId, HTTP_STATUS.BAD_GATEWAY, error.message, provider, model)
        .catch((lockError) => log.warn("AUTH", `Failed to record account error: ${lockError.message}`));
    }
    return rejectChatRequest(cancelled ? 499 : HTTP_STATUS.BAD_GATEWAY, cancelled ? "请求已取消。" : `${error.message || "账号请求失败。"}${sessionHint}`, clientRawRequest, "router");
  } finally {
    credentials.releaseSelection?.();
    if (!responseOwnsPermits) {
      accountPermit?.release();
      apiKeyPermit?.release();
    }
  }
}

function rejectAccountCooldown(status, message, retryAfter, sessionHint, clientRawRequest) {
  const seconds = Math.max(0, Math.ceil((new Date(retryAfter).getTime() - Date.now()) / 1000)) || 0;
  const reason = seconds && /overloaded/i.test(message) ? "当前账号暂时过载。" : message;
  const waitHint = seconds ? ` 请在 ${seconds} 秒后重试。` : "";
  const response = rejectChatRequest(status, `${reason}${waitHint}${sessionHint}`, clientRawRequest, "router");
  if (seconds) response.headers.set("Retry-After", String(seconds));
  return response;
}
