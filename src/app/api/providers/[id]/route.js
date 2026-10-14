import { NextResponse } from "next/server";
import { getAccountExpiry } from "@/lib/accountExpiry";
import { getAccountOverloadWarnings } from "@/lib/db/repos/accountOverloadWarningsRepo";
import { DEFAULT_ACCOUNT_COOLDOWN_MIN_MS, DEFAULT_ACCOUNT_COOLDOWN_MAX_MS } from "open-sse/config/errorConfig.js";
import {
  getProviderConnectionById,
  getProxyPoolById,
  updateProviderConnection,
  deleteProviderConnection,
} from "@/models";
import { toProviderConnectionResponse, usesAwsCredentialForm } from "@/lib/providerConnectionResponse";
import { getApiKeyById } from "@/lib/db/repos/apiKeysRepo.js";
import { getExclusiveApiKeyIds } from "@/shared/utils/accountApiKeyBindings.js";
import { ACCOUNT_QUALITY_LABELS, ACCOUNT_QUALITY_MAX_LENGTH, getAccountQualityStatus, getAccountQualityLabel, getAccountQualityMarkedAt, getAccountQualityColor, isAccountQualityColor } from "@/shared/utils/accountQuality.js";

function normalizeProxyConfig(body = {}) {
  const hasAnyProxyField =
    Object.prototype.hasOwnProperty.call(body, "connectionProxyEnabled") ||
    Object.prototype.hasOwnProperty.call(body, "connectionProxyUrl") ||
    Object.prototype.hasOwnProperty.call(body, "connectionNoProxy");

  if (!hasAnyProxyField) return { hasAnyProxyField: false };

  const enabled = body?.connectionProxyEnabled === true;
  const url = typeof body?.connectionProxyUrl === "string" ? body.connectionProxyUrl.trim() : "";
  const noProxy = typeof body?.connectionNoProxy === "string" ? body.connectionNoProxy.trim() : "";

  if (enabled && !url) {
    return {
      hasAnyProxyField: true,
      error: "Connection proxy URL is required when connection proxy is enabled",
    };
  }

  return {
    hasAnyProxyField: true,
    connectionProxyEnabled: enabled,
    connectionProxyUrl: url,
    connectionNoProxy: noProxy,
  };
}

async function normalizeProxyPoolUpdate(proxyPoolIdInput) {
  if (proxyPoolIdInput === undefined) {
    return { hasProxyPoolField: false, proxyPoolId: null };
  }

  if (proxyPoolIdInput === null || proxyPoolIdInput === "" || proxyPoolIdInput === "__none__") {
    return { hasProxyPoolField: true, proxyPoolId: null };
  }

  const proxyPoolId = String(proxyPoolIdInput).trim();
  if (!proxyPoolId) {
    return { hasProxyPoolField: true, proxyPoolId: null };
  }

  const proxyPool = await getProxyPoolById(proxyPoolId);
  if (!proxyPool) {
    return { hasProxyPoolField: true, error: "Proxy pool not found" };
  }

  return { hasProxyPoolField: true, proxyPoolId };
}

function shouldMergeProviderSpecificData(existing, incoming, hasLegacyProxy, hasProxyPoolField) {
  return existing !== undefined || incoming !== undefined || hasLegacyProxy || hasProxyPoolField;
}

// GET /api/providers/[id] - Get single connection
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    // Hide sensitive fields
    const overloadWarnings = await getAccountOverloadWarnings(id);
    const result = { ...toProviderConnectionResponse(connection), accountExpiry: getAccountExpiry(connection), overloadWarning: overloadWarnings[id] || null };

    return NextResponse.json({ connection: result });
  } catch (error) {
    console.log("Error fetching connection:", error);
    return NextResponse.json({ error: "Failed to fetch connection" }, { status: 500 });
  }
}

// PUT /api/providers/[id] - Update connection
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const {
      name,
      priority,
      maxConcurrency,
      minRequestIntervalMs,
      maxRequestIntervalMs,
      accountCooldownMinMs,
      accountCooldownMaxMs,
      globalPriority,
      defaultModel,
      isActive,
      apiKey,
      testStatus,
      lastError,
      lastErrorAt,
      providerSpecificData
    } = body;

    const existing = await getProviderConnectionById(id);
    if (!existing) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const proxyConfig = normalizeProxyConfig(body);
    if (proxyConfig.error) {
      return NextResponse.json({ error: proxyConfig.error }, { status: 400 });
    }

    const proxyPoolResult = await normalizeProxyPoolUpdate(body.proxyPoolId);
    if (proxyPoolResult.error) {
      return NextResponse.json({ error: proxyPoolResult.error }, { status: 400 });
    }

    const updateData = {};
    if (body.isDegraded !== undefined && typeof body.isDegraded !== "boolean") {
      return NextResponse.json({ error: "降智标记必须为布尔值" }, { status: 400 });
    }
    if (body.qualityLabel !== undefined && body.qualityStatus === undefined) {
      return NextResponse.json({ error: "填写自定义标签时需要指定账号标记类型" }, { status: 400 });
    }
    if (body.qualityColor !== undefined && body.qualityColor !== null && !isAccountQualityColor(body.qualityColor)) {
      return NextResponse.json({ error: "标签颜色必须是 #RRGGBB 格式的颜色值" }, { status: 400 });
    }
    if (body.qualityStatus !== undefined || body.isDegraded !== undefined || body.qualityColor !== undefined) {
      const colorOnly = body.qualityStatus === undefined && body.isDegraded === undefined;
      const status = colorOnly ? getAccountQualityStatus(existing) : body.qualityStatus !== undefined ? body.qualityStatus : body.isDegraded ? "degraded" : null;
      if (status !== null && (typeof status !== "string" || (status !== "custom" && !Object.hasOwn(ACCOUNT_QUALITY_LABELS, status)))) {
        return NextResponse.json({ error: "账号标记类型无效" }, { status: 400 });
      }
      const label = colorOnly ? getAccountQualityLabel(existing) : body.qualityLabel;
      const qualityLabel = status === "custom" && typeof label === "string" ? label.trim() : null;
      if (status === "custom" && (!qualityLabel || qualityLabel.length > ACCOUNT_QUALITY_MAX_LENGTH)) {
        return NextResponse.json({ error: `自定义标签需填写 1 至 ${ACCOUNT_QUALITY_MAX_LENGTH} 个字符` }, { status: 400 });
      }
      if (status !== "custom" && body.qualityLabel !== undefined && body.qualityLabel !== null) {
        return NextResponse.json({ error: "自定义标签需要使用自定义标记类型" }, { status: 400 });
      }
      if (body.isDegraded !== undefined && body.isDegraded !== (status === "degraded")) {
        return NextResponse.json({ error: "账号标记与降智状态不一致" }, { status: 400 });
      }
      if (!status && body.qualityColor != null) {
        return NextResponse.json({ error: "请先填写标签再选择颜色" }, { status: 400 });
      }
      const qualityColor = status ? getAccountQualityColor(body.qualityColor === undefined ? existing : body) : null;
      const unchanged = status === getAccountQualityStatus(existing) && (status !== "custom" || qualityLabel === getAccountQualityLabel(existing)) && qualityColor === getAccountQualityColor(existing);
      const markedAt = status
        ? (unchanged && getAccountQualityMarkedAt(existing)) || new Date().toISOString()
        : null;
      Object.assign(updateData, {
        qualityStatus: status,
        qualityLabel,
        qualityColor,
        qualityMarkedAt: markedAt,
        isDegraded: status === "degraded",
        degradedMarkedAt: status === "degraded" ? markedAt : null,
      });
    }
    if (body.exclusiveApiKeyIds !== undefined) {
      const value = body.exclusiveApiKeyIds;
      if (!Array.isArray(value) || value.some(id => typeof id !== "string" || !id.trim())) {
        return NextResponse.json({ error: "专用 API Key 必须是有效 ID 的数组" }, { status: 400 });
      }
      const ids = [...new Set(value.map(id => id.trim()))];
      const existingIds = getExclusiveApiKeyIds(existing);
      for (const keyId of ids.filter(id => !existingIds.includes(id))) {
        const key = await getApiKeyById(keyId);
        if (!key?.isActive) {
          return NextResponse.json({ error: "请选择存在且已启用的 API Key" }, { status: 400 });
        }
      }
      updateData.exclusiveApiKeyIds = ids;
    }
    if (body.accountExpiresAt !== undefined) {
      if (body.accountExpiresAt !== null && (typeof body.accountExpiresAt !== "string" || !Number.isFinite(new Date(body.accountExpiresAt).getTime()))) {
        return NextResponse.json({ error: "账号到期时间无效" }, { status: 400 });
      }
      updateData.accountExpiresAt = body.accountExpiresAt === null ? null : new Date(body.accountExpiresAt).toISOString();
    }
    if (name !== undefined) updateData.name = name;
    if (priority !== undefined) updateData.priority = priority;
    if (maxConcurrency !== undefined) {
      if (!Number.isInteger(maxConcurrency) || maxConcurrency < 0 || maxConcurrency > 1000) {
        return NextResponse.json({ error: "maxConcurrency must be an integer between 0 and 1000" }, { status: 400 });
      }
      updateData.maxConcurrency = maxConcurrency;
    }
    if (minRequestIntervalMs !== undefined) {
      if (!Number.isInteger(minRequestIntervalMs) || minRequestIntervalMs < 0 || minRequestIntervalMs > 60000) {
        return NextResponse.json({ error: "minRequestIntervalMs must be an integer between 0 and 60000" }, { status: 400 });
      }
      updateData.minRequestIntervalMs = minRequestIntervalMs;
    }
    if (maxRequestIntervalMs !== undefined) {
      if (!Number.isInteger(maxRequestIntervalMs) || maxRequestIntervalMs < 0 || maxRequestIntervalMs > 60000) {
        return NextResponse.json({ error: "maxRequestIntervalMs must be an integer between 0 and 60000" }, { status: 400 });
      }
      updateData.maxRequestIntervalMs = maxRequestIntervalMs;
    }
    const nextMinRequestIntervalMs = minRequestIntervalMs ?? (Number(existing.minRequestIntervalMs) || 0);
    const nextMaxRequestIntervalMs = maxRequestIntervalMs ?? (Number(existing.maxRequestIntervalMs) || nextMinRequestIntervalMs);
    if (nextMinRequestIntervalMs > 0 && nextMaxRequestIntervalMs > 0 && nextMinRequestIntervalMs > nextMaxRequestIntervalMs) {
      return NextResponse.json({ error: "minRequestIntervalMs cannot be greater than maxRequestIntervalMs" }, { status: 400 });
    }
    if (accountCooldownMinMs !== undefined) {
      if (!Number.isInteger(accountCooldownMinMs) || accountCooldownMinMs < 1000 || accountCooldownMinMs > 3600000) {
        return NextResponse.json({ error: "accountCooldownMinMs must be an integer between 1000 and 3600000" }, { status: 400 });
      }
      updateData.accountCooldownMinMs = accountCooldownMinMs;
    }
    if (accountCooldownMaxMs !== undefined) {
      if (!Number.isInteger(accountCooldownMaxMs) || accountCooldownMaxMs < 1000 || accountCooldownMaxMs > 3600000) {
        return NextResponse.json({ error: "accountCooldownMaxMs must be an integer between 1000 and 3600000" }, { status: 400 });
      }
      updateData.accountCooldownMaxMs = accountCooldownMaxMs;
    }
    const nextAccountCooldownMinMs = accountCooldownMinMs ?? (Number(existing.accountCooldownMinMs) || DEFAULT_ACCOUNT_COOLDOWN_MIN_MS);
    const nextAccountCooldownMaxMs = accountCooldownMaxMs ?? (Number(existing.accountCooldownMaxMs) || DEFAULT_ACCOUNT_COOLDOWN_MAX_MS);
    if (nextAccountCooldownMinMs > nextAccountCooldownMaxMs) {
      return NextResponse.json({ error: "accountCooldownMinMs cannot be greater than accountCooldownMaxMs" }, { status: 400 });
    }
    if (globalPriority !== undefined) updateData.globalPriority = globalPriority;
    if (defaultModel !== undefined) updateData.defaultModel = defaultModel;
    if (isActive !== undefined) updateData.isActive = isActive;
    if (apiKey && existing.authType === "apikey") updateData.apiKey = apiKey;
    if (testStatus !== undefined) updateData.testStatus = testStatus;
    if (lastError !== undefined) updateData.lastError = lastError;
    if (lastErrorAt !== undefined) updateData.lastErrorAt = lastErrorAt;

    if (
      shouldMergeProviderSpecificData(
        existing.providerSpecificData,
        providerSpecificData,
        proxyConfig.hasAnyProxyField,
        proxyPoolResult.hasProxyPoolField
      )
    ) {
      const incomingProviderSpecificData = { ...(providerSpecificData || {}) };
      const isAwsCredential = usesAwsCredentialForm(existing.provider);
      // The edit form cannot read the stored token back. An empty password field means
      // keep the saved credential; null explicitly removes it.
      if (isAwsCredential && incomingProviderSpecificData.sessionToken === "") {
        delete incomingProviderSpecificData.sessionToken;
      }
      updateData.providerSpecificData = {
        ...(existing.providerSpecificData || {}),
        ...incomingProviderSpecificData,
      };
      if (isAwsCredential && incomingProviderSpecificData.sessionToken === null) {
        delete updateData.providerSpecificData.sessionToken;
      }

      if (proxyConfig.hasAnyProxyField) {
        updateData.providerSpecificData.connectionProxyEnabled = proxyConfig.connectionProxyEnabled;
        updateData.providerSpecificData.connectionProxyUrl = proxyConfig.connectionProxyUrl;
        updateData.providerSpecificData.connectionNoProxy = proxyConfig.connectionNoProxy;
      }

      if (proxyPoolResult.hasProxyPoolField) {
        if (proxyPoolResult.proxyPoolId === null) {
          delete updateData.providerSpecificData.proxyPoolId;
        } else {
          updateData.providerSpecificData.proxyPoolId = proxyPoolResult.proxyPoolId;
        }
      }
    }

    const updated = await updateProviderConnection(id, updateData);

    // Hide sensitive fields
    const result = { ...toProviderConnectionResponse(updated), accountExpiry: getAccountExpiry(updated) };

    return NextResponse.json({ connection: result });
  } catch (error) {
    if (error.code === "EXCLUSIVE_API_KEY_CONFLICT") {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.log("Error updating connection:", error);
    return NextResponse.json({ error: "Failed to update connection" }, { status: 500 });
  }
}

// DELETE /api/providers/[id] - Delete connection
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const deleted = await deleteProviderConnection(id);
    if (!deleted) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Connection deleted successfully" });
  } catch (error) {
    console.log("Error deleting connection:", error);
    return NextResponse.json({ error: "Failed to delete connection" }, { status: 500 });
  }
}
