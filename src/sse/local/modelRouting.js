import { getProviderConnectionById, getSettings } from "@/lib/localDb";
import { trackModelRequest } from "@/lib/runtimeModelStats.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { errorResponse } from "open-sse/utils/error.js";
import { upstreamResponseHeaders } from "open-sse/utils/upstreamHeaders.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { isModelLockActive, getModelLockUntil } from "open-sse/services/accountFallback.js";
import { getProviderCredentials, markAccountUnavailable, clearAccountError } from "./auth.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
import { getSessionRoutingKey, NEW_SESSION_HINT } from "../services/sessionRouting.js";
import { getModelInfo, getComboModels, getComboAccountModels } from "../services/model.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import {
  acquireConcurrencySlot, holdConcurrencyUntilResponseDone, ConcurrencyQueueError,
  getConcurrencySnapshot, pauseAccountQueue, resumeAccountQueue, queueTimeoutMs,
} from "../services/concurrencyLimiter.js";
import * as log from "../utils/logger.js";
import { getRequestId, rejectChatRequest, buildConcurrencyMetadata, getProviderCapacityState } from "./requestContext.js";
import { getCodexRoutingPolicy } from "./routingPolicy.js";
import { isCodexQuotaError, getAccountQuotaState } from "./quotaRouting.js";
import { handleLocalCombo } from "./comboRouting.js";
import { acquireAccountSlot } from "./accountLoad.js";

/**
 * Handle single model chat request
 */
export async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, seenModels = new Set(), excludedAccounts = new Set(), deadline = Date.now() + queueTimeoutMs(), retryCount = 0, comboNames = []) {
  if (seenModels.has(modelStr)) return rejectChatRequest(HTTP_STATUS.BAD_REQUEST, "模型组合存在循环引用。", clientRawRequest, "router");
  seenModels.add(modelStr);
  const requestId = getRequestId(request);
  // Resolve combo aliases (including cc/<name>) before provider prefixes.
  const comboModels = await getComboModels(modelStr);
  if (comboModels?.length) {
    return handleLocalCombo(body, comboModels, modelStr, (_body, candidate) =>
      handleSingleModelChat(_body, candidate, clientRawRequest, request, apiKey, new Set(seenModels), new Set(excludedAccounts), deadline, retryCount, [...comboNames, modelStr]));
  }
  const modelInfo = await getModelInfo(modelStr);

  if (modelInfo.disabled) {
    return rejectChatRequest(HTTP_STATUS.FORBIDDEN, `组合“${modelInfo.model}”已禁用。`, clientRawRequest, "router");
  }

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return rejectChatRequest(HTTP_STATUS.BAD_REQUEST, "Invalid model format", clientRawRequest);
  }

  const { provider } = modelInfo;
  let { model } = modelInfo;
  const modelByConnection = await getComboAccountModels(comboNames, provider);

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  const sessionKey = getSessionRoutingKey(clientRawRequest?.headers, clientRawRequest?.body || body, clientRawRequest?.apiKeyRecordId || apiKey);
  const chatSettings = await getSettings();
  const codexPolicy = provider === "codex" ? getCodexRoutingPolicy(chatSettings) : null;
  const sessionHint = sessionKey ? ` ${codexPolicy?.quotaFailover ? "当前会话保持账号绑定；额度耗尽时自动迁移。" : NEW_SESSION_HINT}` : "";
  const credentials = await getProviderCredentials(provider, excludedAccounts, model, {
    sessionKey, fillFirst: true, waitForCooldown: true, modelByConnection,
    contextMarker: clientRawRequest?.modelContextMarker,
  });
  if (!credentials || credentials.sessionUnavailable || credentials.allRateLimited) {
    const status = Number(credentials?.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
    if (!sessionKey && excludedAccounts.size > 0) return errorResponse(status, credentials?.lastError || "暂无可用账号。", clientRawRequest?.upstreamErrorHeaders);
    return rejectAccountCooldown(status, credentials?.lastError || "暂无可用账号。", credentials?.retryAfter, sessionHint, clientRawRequest, clientRawRequest?.upstreamErrorHeaders);
  }

  model = credentials.routingModel || modelByConnection[credentials.connectionId] || model;

  let apiKeyPermit = null;
  let accountPermit = null;
  let responseOwnsPermits = false;
  Object.assign(clientRawRequest, { provider, routingModel: model, connectionId: credentials.connectionId, retryCount, deadline });
  const modelStats = trackModelRequest(request, { connectionId: credentials.connectionId, provider, model, requestId, endpoint: clientRawRequest?.endpoint, caller: clientRawRequest });
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
    Object.assign(clientRawRequest, concurrencyMetadata);
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
          if (error instanceof ConcurrencyQueueError) return rejectChatRequest(error.status, error.message, { ...clientRawRequest, ...error.requestContext }, "router");
          throw error;
        }
      }
    }

    try {
      const lockedUntil = new Date(getModelLockUntil(credentials._connection, model)).getTime();
      if (sessionKey && Number(credentials._connection?.errorCode) === 503 && lockedUntil > Date.now()) {
        pauseAccountQueue(credentials.connectionId, lockedUntil);
      }
      const accountPermitPromise = acquireAccountSlot({
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
      }, credentials.releaseSelection);
      accountPermit = await accountPermitPromise;
      clientRawRequest.state = "running";
      clientRawRequest.waitMs = accountPermit.waitMs;
      clientRawRequest.queuedAt = accountPermit.queued ? Date.now() - accountPermit.waitMs : null;
    } catch (error) {
      if (error instanceof ConcurrencyQueueError) {
        // A queue timeout is a capacity failure for this request, not an
        // upstream account error. Return immediately instead of waiting on
        // every account in sequence.
        return rejectChatRequest(error.status, error.message, { ...clientRawRequest, ...error.requestContext }, "router");
      }
      throw error;
    }

    // A queued request may acquire the slot after an earlier request locked
    // this account; re-check persisted state before sending upstream traffic.
    const liveConnection = credentials.connectionId === "noauth"
      ? credentials
      : await getProviderConnectionById(credentials.connectionId);
    const liveQuota = codexPolicy && liveConnection ? getAccountQuotaState(liveConnection, model, null, codexPolicy) : null;
    if (liveQuota?.exhausted) {
      if (!sessionKey || codexPolicy.quotaFailover) {
        excludedAccounts.add(credentials.connectionId);
        accountPermit?.release(); accountPermit = null;
        apiKeyPermit?.release(); apiKeyPermit = null;
        return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, new Set(), excludedAccounts, deadline, retryCount + 1, comboNames);
      }
      return rejectAccountCooldown(429, "当前会话绑定的账号额度已用尽。", liveQuota.retryAt, sessionHint, clientRawRequest);
    }
    if (!liveConnection || !liveConnection.isActive || isModelLockActive(liveConnection, model)) {
      if (!sessionKey) {
        excludedAccounts.add(credentials.connectionId);
        return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, new Set(), excludedAccounts, deadline, retryCount, comboNames);
      }
      if (liveConnection?.isActive && Number(liveConnection.errorCode) === 503 && isModelLockActive(liveConnection, model)) {
        return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, new Set(), excludedAccounts, deadline, retryCount, comboNames);
      }
      return rejectAccountCooldown(Number(liveConnection?.errorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE, liveConnection?.lastError || "当前会话绑定的账号暂不可用。", getModelLockUntil(liveConnection, model), sessionHint, clientRawRequest);
    }

    const attemptTimeout = new AbortController();
    const attemptTimer = sessionKey ? setTimeout(() => attemptTimeout.abort(), Math.max(0, deadline - Date.now())) : null;
    const accountState = getConcurrencySnapshot().find(item => item.scope === "account" && item.id === credentials.connectionId);
    const diagnosticContext = {
      requestId, connectionId: credentials.connectionId, retryCount,
      session: sessionKey?.slice(0, 12) || null,
      active: accountState?.active || 1, queued: accountState?.queued || 0,
      limit: credentials.maxConcurrency || 0, accountState: accountState?.state || "running",
      waitMs: accountPermit.waitMs, remainingMs: Math.max(0, deadline - Date.now()),
      requestBytes: concurrencyMetadata.requestBytes, thinking: concurrencyMetadata.thinkingLevel,
      proxyConfigured: !!(refreshedCredentials.providerSpecificData?.connectionProxyEnabled || refreshedCredentials.providerSpecificData?.vercelRelayUrl),
      proxyPoolId: refreshedCredentials.providerSpecificData?.connectionProxyPoolId || null,
    };
    Object.assign(clientRawRequest, {
      proxyConfigured: diagnosticContext.proxyConfigured,
      proxyPoolId: diagnosticContext.proxyPoolId,
    });
    log.info("ACCOUNT_ATTEMPT", `${provider}/${model}`, diagnosticContext);
    let result;
    try {
      result = await handleChatCore({
      retryCount,
      requestId,
      diagnosticContext,
      onUpstreamOverload: modelStats.onOverload,
      onRequestComplete: modelStats.onComplete,
      body: { ...structuredClone(body), model: `${provider}/${model}` },
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
      // Per-provider user overrides (custom headers / connect timeout) from settings
      providerOverrides: (chatSettings.providerOverrides || {})[provider] || null,
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
    if (result.status === HTTP_STATUS.SERVICE_UNAVAILABLE) modelStats.onOverload();

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
    clientRawRequest.upstreamErrorHeaders = upstreamResponseHeaders(result.response?.headers);
    let shouldFallback = !!quotaResetMs;
    if (!(provider === "antigravity" && quotaResetMs)) {
      ({ shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, resetsAtMs));
    }
    const retry = async () => {
      await result.response?.body?.cancel().catch(() => {});
      // Recursion must not acquire this request's API Key/account permit again
      // while it is still held by the failed attempt.
      accountPermit?.release(); accountPermit = null;
      apiKeyPermit?.release(); apiKeyPermit = null;
      return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, new Set(), excludedAccounts, deadline, retryCount + 1, comboNames);
    };
    if (sessionKey && codexPolicy?.quotaFailover && isCodexQuotaError(provider, result.status, result.error)) {
      excludedAccounts.add(credentials.connectionId);
      return retry();
    }
    if (sessionKey && result.status === HTTP_STATUS.SERVICE_UNAVAILABLE) {
      return retry();
    }
    if (!sessionKey && shouldFallback && credentials.connectionId !== "noauth") {
      excludedAccounts.add(credentials.connectionId);
      return retry();
    }
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, `${result.error || "账号请求失败。"}${sessionHint}`, clientRawRequest.upstreamErrorHeaders);
  } catch (error) {
    if (sessionKey && Date.now() >= deadline && !request?.signal?.aborted) {
      return rejectChatRequest(503, "账号繁忙，等待重试已超过时限，请稍后重试。", clientRawRequest, "router");
    }
    const cancelled = request?.signal?.aborted || error.name === "AbortError";
    if (!cancelled) {
      await markAccountUnavailable(credentials.connectionId, HTTP_STATUS.BAD_GATEWAY, error.message, provider, model)
        .catch((lockError) => log.warn("AUTH", `Failed to record account error: ${lockError.message}`));
    }
    const networkCode = error?.cause?.code || error?.code || null;
    return rejectChatRequest(
      cancelled ? 499 : HTTP_STATUS.BAD_GATEWAY,
      cancelled ? "请求已取消。" : `${error.message || "账号请求失败。"}${sessionHint}`,
      { ...clientRawRequest, networkCode },
      "router",
    );
  } finally {
    credentials.releaseSelection?.();
    if (!responseOwnsPermits) {
      accountPermit?.release();
      apiKeyPermit?.release();
    }
  }
}

function rejectAccountCooldown(status, message, retryAfter, sessionHint, clientRawRequest, extraHeaders = null) {
  const seconds = Math.max(0, Math.ceil((new Date(retryAfter).getTime() - Date.now()) / 1000)) || 0;
  const reason = seconds && /overloaded/i.test(message) ? "当前账号暂时过载。" : message;
  const waitHint = seconds ? ` 请在 ${seconds} 秒后重试。` : "";
  const response = rejectChatRequest(status, `${reason}${waitHint}${sessionHint}`, clientRawRequest, "router", extraHeaders);
  if (seconds) response.headers.set("Retry-After", String(seconds));
  return response;
}
