import { getProviderConnectionById, getProviderConnections, getSettings } from "@/lib/localDb";
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
import { getSessionRoutingKey } from "../services/sessionRouting.js";
import { getModelInfo, getComboModels, getComboAccountModels } from "../services/model.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import {
  acquireConcurrencySlot, holdConcurrencyUntilResponseDone, ConcurrencyQueueError,
  getConcurrencySnapshot, resumeAccountQueue, queueTimeoutMs,
} from "../services/concurrencyLimiter.js";
import * as log from "../utils/logger.js";
import { getRequestId, rejectChatRequest, buildConcurrencyMetadata, getProviderCapacityState } from "./requestContext.js";
import { getCodexRoutingPolicy } from "./routingPolicy.js";
import { isCodexQuotaError, getAccountQuotaState } from "./quotaRouting.js";
import { handleLocalCombo } from "./comboRouting.js";
import { getKeyAccessContext, filterAdapterModels, extractClientApiKey } from "../services/keyAccess.js";
import { acquireAccountSlot, getAccountActiveCount } from "./accountLoad.js";
import { getApiKeyRoutingKey } from "./apiKeyRouting.js";
import { filterAccountPoolForRequest, getRequestKeyId } from "../services/accountApiKeyAccess.js";
import { appendChatErrorHint } from "../utils/errorHints.js";
import { getTrialSession, getTrialCredentials } from "./codexTrialSession.js";
import { CODEX_TRIAL_IDENTITY } from "@/shared/utils/codexTrialIdentity.js";

/**
 * Handle single model chat request
 */
export async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, seenModels = new Set(), excludedAccounts = new Set(), deadline = Date.now() + queueTimeoutMs(), retryCount = 0, comboNames = []) {
  const trial = getTrialSession(request);
  if (seenModels.has(modelStr)) return rejectChatRequest(HTTP_STATUS.BAD_REQUEST, "模型组合存在循环引用。", clientRawRequest, "router");
  seenModels.add(modelStr);
  const requestId = getRequestId(request);
  const sessionKey = trial ? null : getSessionRoutingKey(clientRawRequest?.headers, clientRawRequest?.body || body, clientRawRequest?.apiKeyRecordId || apiKey);
  // Resolve combo aliases (including cc/<name>) before provider prefixes.
  const apiKeyId = await getRequestKeyId(request);
  const comboModels = await getComboModels(modelStr, apiKeyId);
  if (comboModels?.length) {
    return handleLocalCombo(body, comboModels, modelStr, (_body, candidate) =>
      handleSingleModelChat(_body, candidate, clientRawRequest, request, apiKey, new Set(seenModels), new Set(excludedAccounts), deadline, retryCount, [...comboNames, modelStr]),
      { request, sessionId: sessionKey });
  }
  const modelInfo = await getModelInfo(modelStr, apiKeyId);

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
  if (trial && (provider !== (trial.provider || "codex") || model !== trial.model)) return rejectChatRequest(400, "试用任务不允许切换模型或提供商。", clientRawRequest);
  const modelByConnection = await getComboAccountModels(comboNames, provider);

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  const chatSettings = await getSettings();
  const codexPolicy = provider === "codex" && !trial ? getCodexRoutingPolicy(chatSettings) : null;
  const apiKeyRoutingKey = codexPolicy?.apiKeyAffinity
    ? getApiKeyRoutingKey(provider, clientRawRequest?.apiKeyRecordId, apiKey || extractClientApiKey(request))
    : null;
  const stickyBinding = !!(trial || apiKeyRoutingKey || sessionKey);
  const quotaFailover = !!(apiKeyRoutingKey || codexPolicy?.quotaFailover);
  // Automatic quota downgrades must respect the key's model allow list.
  const fallbackModels = codexPolicy?.quotaModelSwitch
    ? await filterAdapterModels(await getKeyAccessContext(request), [`${provider}/${codexPolicy.quotaFallbackModel}`], [])
    : null;
  const credentials = trial ? await getTrialCredentials(trial) : await getProviderCredentials(provider, excludedAccounts, model, {
    request,
    sessionKey, apiKeyRoutingKey, apiKeyRecordId: clientRawRequest?.apiKeyRecordId, fillFirst: true, modelByConnection,
    contextMarker: clientRawRequest?.modelContextMarker,
    allowQuotaModelSwitch: !fallbackModels || fallbackModels.length > 0,
  });
  if (!credentials || credentials.sessionUnavailable || credentials.allRateLimited) {
    const status = Number(credentials?.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
    if (!stickyBinding && excludedAccounts.size > 0) return errorResponse(status, appendChatErrorHint(status, credentials?.lastError || "暂无可用账号。", { source: "router" }), clientRawRequest?.upstreamErrorHeaders);
    return rejectAccountCooldown(status, credentials?.lastError || "暂无可用账号。", credentials?.retryAfter, clientRawRequest, clientRawRequest?.upstreamErrorHeaders);
  }

  model = credentials.routingModel || modelByConnection[credentials.connectionId] || model;

  let apiKeyPermit = null;
  let accountPermit = null;
  let responseOwnsPermits = false;
  Object.assign(clientRawRequest, { provider, routingModel: model, connectionId: credentials.connectionId, retryCount, deadline });
  const modelStats = trackModelRequest(request, { connectionId: credentials.connectionId, provider, model, requestId, endpoint: clientRawRequest?.endpoint, caller: clientRawRequest });
  const retry = async (response = null) => {
    await response?.body?.cancel().catch(() => {});
    // Release permits before recursion so the next account can be acquired.
    accountPermit?.release(); accountPermit = null;
    apiKeyPermit?.release(); apiKeyPermit = null;
    return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, new Set(), excludedAccounts, deadline, retryCount + 1, comboNames);
  };
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
    const providerThinking = trial ? null : (chatSettings.providerThinking || {})[provider] || null;
    const concurrencyMetadata = buildConcurrencyMetadata({
      body,
      clientRawRequest,
      request,
      provider,
      model,
      credentials: refreshedCredentials,
      apiKey: trial ? CODEX_TRIAL_IDENTITY.key : apiKey,
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
      const providerCapacity = await getProviderCapacityState(provider, request);
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
    // Administrative removal may happen while the request is queued. Release
    // the old permits and reselect without sending traffic to that account.
    if (trial && !liveConnection) return rejectChatRequest(404, "试用账号已删除。", clientRawRequest);
    if (!liveConnection || (!liveConnection.isActive && !trial)) {
      excludedAccounts.add(credentials.connectionId);
      return retry();
    }
    if (credentials.connectionId !== "noauth" && !trial) {
      const accessible = await filterAccountPoolForRequest(await getProviderConnections({ provider }), request);
      if (!accessible.some(c => c.id === credentials.connectionId)) {
        excludedAccounts.add(credentials.connectionId);
        return retry();
      }
    }
    const liveQuota = codexPolicy && liveConnection ? getAccountQuotaState(liveConnection, model, null, codexPolicy) : null;
    if (liveQuota?.exhausted) {
      if (!stickyBinding || quotaFailover) {
        excludedAccounts.add(credentials.connectionId);
        return retry();
      }
      return rejectAccountCooldown(429, "当前会话绑定的账号额度已用尽。", liveQuota.retryAt, clientRawRequest);
    }
    if (isModelLockActive(liveConnection, model)) {
      if (!stickyBinding && Number(liveConnection?.errorCode) !== HTTP_STATUS.SERVICE_UNAVAILABLE) {
        excludedAccounts.add(credentials.connectionId);
        return retry();
      }
      return rejectAccountCooldown(Number(liveConnection?.errorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE, liveConnection?.lastError || "绑定的账号暂不可用。", getModelLockUntil(liveConnection, model), clientRawRequest);
    }

    const attemptTimeout = new AbortController();
    const attemptTimer = stickyBinding ? setTimeout(() => attemptTimeout.abort(), Math.max(0, deadline - Date.now())) : null;
    const accountState = getConcurrencySnapshot().find(item => item.scope === "account" && item.id === credentials.connectionId);
    const diagnosticContext = {
      requestId, connectionId: credentials.connectionId, retryCount,
      session: sessionKey?.slice(0, 12) || null,
      active: Math.max(accountState?.active || 0, getAccountActiveCount(credentials.connectionId)), queued: accountState?.queued || 0,
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
      apiKey: trial ? CODEX_TRIAL_IDENTITY.key : apiKey,
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
      customPromptEnabled: !trial && !!chatSettings.customPromptEnabled,
      customPrompt: chatSettings.customPrompt || "",
      clientAbortSignal: stickyBinding ? AbortSignal.any([request?.signal, attemptTimeout.signal].filter(Boolean)) : request?.signal,
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
    let cooldownMs = 0;
    if (!(provider === "antigravity" && quotaResetMs)) {
      ({ shouldFallback, cooldownMs } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, resetsAtMs));
    }
    if (stickyBinding && quotaFailover && isCodexQuotaError(provider, result.status, result.error)) {
      excludedAccounts.add(credentials.connectionId);
      return retry(result.response);
    }
    if (!stickyBinding && shouldFallback && result.status !== HTTP_STATUS.SERVICE_UNAVAILABLE && credentials.connectionId !== "noauth") {
      excludedAccounts.add(credentials.connectionId);
      return retry(result.response);
    }
    await result.response?.body?.cancel().catch(() => {});
    const response = errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY,
      appendChatErrorHint(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "账号请求失败。", {
        source: "upstream", retryAfterSeconds: result.status === HTTP_STATUS.SERVICE_UNAVAILABLE ? cooldownMs / 1000 : 0,
      }), clientRawRequest.upstreamErrorHeaders);
    if (result.status === HTTP_STATUS.SERVICE_UNAVAILABLE && cooldownMs > 0) {
      response.headers.set("Retry-After", String(Math.ceil(cooldownMs / 1000)));
    }
    return response;
  } catch (error) {
    if (stickyBinding && Date.now() >= deadline && !request?.signal?.aborted) {
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
      cancelled ? "请求已取消。" : error.message || "账号请求失败。",
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

function rejectAccountCooldown(status, message, retryAfter, clientRawRequest, extraHeaders = null) {
  const seconds = Math.max(0, Math.ceil((new Date(retryAfter).getTime() - Date.now()) / 1000)) || 0;
  const response = rejectChatRequest(status, message, clientRawRequest, "router", extraHeaders, { retryAfterSeconds: seconds });
  if (seconds) response.headers.set("Retry-After", String(seconds));
  return response;
}
