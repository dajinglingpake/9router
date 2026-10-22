import codex, { CODEX_SESSIONS_CONFIG } from "open-sse/providers/registry/codex.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { getProviderConnectionById, updateProviderConnection } from "@/lib/db/repos/connectionsRepo.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/lib/providerUsage";
import { createHash } from "node:crypto";

const pending = new Map();
const queries = new Map();
const failure = (message, status, code = "upstream_error") => Object.assign(new Error(message), { status, code });

async function getConnection(connectionId) {
  const original = await getProviderConnectionById(connectionId);
  if (!original) throw failure("账号不存在，请刷新页面。", 404);
  if (original.provider !== "codex" || !["oauth", "access_token"].includes(original.authType)) {
    throw failure("当前仅支持 Codex 账号管理设备会话。", 400);
  }
  return original;
}

async function requestSessions(original, method, url) {
  if (!original.accessToken) throw failure("账号没有有效登录凭证，请重新登录后刷新设备列表。", 400, "not_logged_in");
  const proxy = await resolveConnectionProxyConfig(original.providerSpecificData || {});
  const options = { ...proxy, signal: AbortSignal.timeout(CODEX_SESSIONS_CONFIG.timeoutMs) };
  let connection;
  try { connection = (await refreshAndUpdateCredentials(original, false, options)).connection; } catch {
    throw failure("当前登录凭证不可用，请重新登录后再操作。", 401, "credentials_expired");
  }
  const send = () => {
    const data = connection.providerSpecificData || {};
    const accountId = data.workspaceId || data.accountId || data.chatgptAccountId;
    return proxyAwareFetch(url, {
      method, redirect: "error", cache: "no-store",
      headers: {
        ...codex.transport.headers, Accept: "application/json", "Content-Type": "application/json",
        Authorization: `Bearer ${connection.accessToken}`,
        ...(accountId ? { "ChatGPT-Account-ID": accountId } : {}),
      },
    }, options);
  };
  let response;
  try {
    response = await send();
    if (response.status === 401 && connection.refreshToken) {
      connection = (await refreshAndUpdateCredentials(connection, true, options)).connection;
      response = await send();
    }
  } catch {
    throw failure("未能获取 OpenAI 的确认结果，请检查网络或在 ChatGPT 网页安全设置中核实。", 502, "network_error");
  }
  if (!response.ok) {
    const challenge = response.headers.get("cf-mitigated") === "challenge";
    const message = challenge ? "OpenAI 要求网页登录验证，暂时无法核实设备及退出结果。请在 ChatGPT 网页安全设置中查看。"
      : response.status === 401 ? "登录凭证已失效，请重新登录后刷新设备列表。"
        : response.status === 403 ? "OpenAI 拒绝了会话管理请求，暂时无法核实设备及退出结果。"
          : "OpenAI 会话管理接口暂时不可用，请稍后刷新或在网页安全设置中核实。";
    throw failure(message, response.status >= 400 && response.status < 500 ? response.status : 502,
      challenge ? "browser_verification_required" : response.status === 401 ? "credentials_expired" : "upstream_error");
  }
  try {
    const text = await response.text();
    const data = text.trim() ? JSON.parse(text) : null;
    if (data === false || data?.error || data?.success === false) throw new Error("Rejected");
    return { data, connection };
  } catch {
    throw failure("OpenAI 返回了无法识别的会话管理结果，请在 ChatGPT 网页安全设置中核实。", 502, "invalid_response");
  }
}

const text = value => typeof value === "string" ? value.trim().slice(0, 200) : "";
export function parseCodexDevices(payload) {
  if (payload?.show_session_manager === false) throw failure("OpenAI 未向此账号开放设备会话列表，暂时无法核实退出结果。", 403, "sessions_unavailable");
  if (!Array.isArray(payload?.devices) || payload.devices.some(device => !device || typeof device !== "object" || Array.isArray(device))) {
    throw failure("OpenAI 未返回有效的设备列表，暂时无法核实退出结果。", 502, "invalid_response");
  }
  const devices = new Map();
  for (const raw of payload.devices) {
    const sessionId = typeof raw.session_id === "string" ? raw.session_id.trim() : "";
    const deviceId = typeof raw.hashed_device_id === "string" ? raw.hashed_device_id.trim() : "";
    const name = text(raw.display_name) || text(raw.device_model) || "未知设备";
    const platform = text(raw.platform);
    const apps = [...new Set((Array.isArray(raw.app_sessions) ? raw.app_sessions : []).map(app => text(app?.client_name)).filter(Boolean))].slice(0, 10);
    const timestamp = Number(raw.last_signed_in_timestamp_second) * 1000;
    const signedInAt = Number.isFinite(timestamp) && timestamp > 0 && timestamp <= 8640000000000000 ? new Date(timestamp).toISOString() : null;
    if (!sessionId && !deviceId && !text(raw.display_name) && !text(raw.device_model) && !platform && !apps.length && !signedInAt) {
      throw failure("OpenAI 返回了无法识别的设备信息，暂时无法核实退出结果。", 502, "invalid_response");
    }
    const identity = sessionId || deviceId || JSON.stringify([name, platform, signedInAt, apps]);
    const id = createHash("sha256").update(identity).digest("hex").slice(0, 24);
    const signedOut = raw.is_trusted_device === true && raw.can_untrust === true && raw.is_current_device !== true && !sessionId && !!deviceId;
    devices.set(id, { id, name, platform, apps, signedInAt,
      location: [text(raw.last_signed_in_city), text(raw.last_signed_in_region_code), text(raw.last_signed_in_country)].filter(Boolean).join("，"),
      isCurrentSession: raw.is_current_device === true, isTrusted: raw.is_trusted_device === true,
      status: sessionId || raw.is_current_device === true ? "active" : signedOut ? "signed_out" : "unknown" });
  }
  return [...devices.values()];
}

async function listSessions(connectionId) {
  const original = await getConnection(connectionId);
  const metadata = { connectionId, source: "openai" };
  try {
    const { data } = await requestSessions(original, "GET", CODEX_SESSIONS_CONFIG.listUrl);
    const devices = parseCodexDevices(data);
    return { ...metadata, checkedAt: new Date().toISOString(), verified: true, devices, currentDeviceCount: devices.length };
  } catch (error) {
    return { ...metadata, checkedAt: new Date().toISOString(), devices: [], verified: false,
      errorCode: error.code || "query_failed", upstreamStatus: error.status || null,
      warning: error.status ? error.message : "设备列表查询失败，无法核实当前设备及退出结果。" };
  }
}

export function getCodexSessions(connectionId) {
  if (!queries.has(connectionId)) queries.set(connectionId, listSessions(connectionId).finally(() => queries.delete(connectionId)));
  return queries.get(connectionId);
}

async function logout(connectionId) {
  const original = await getConnection(connectionId);
  const { connection } = await requestSessions(original, "POST", CODEX_SESSIONS_CONFIG.logoutAllUrl);

  // Do not erase credentials from a new login completed while logout was pending.
  try {
    const latest = await getProviderConnectionById(connectionId);
    if (!latest || latest.accessToken !== connection.accessToken || latest.refreshToken !== connection.refreshToken) {
      return { logoutRequested: true, localUpdated: false, warning: "退出请求已提交；本地账号已删除或登录凭证已更新，未改动新的登录状态。" };
    }
    const loggedOutAt = new Date().toISOString();
    const updated = await updateProviderConnection(connectionId, {
      isActive: false, accessToken: null, refreshToken: null, idToken: null,
      expiresAt: null, expiresIn: null, lastRefreshAt: null,
      testStatus: "logged_out", lastError: "已提交退出所有设备，请重新登录。", lastErrorAt: loggedOutAt,
      providerSpecificData: { ...latest.providerSpecificData,
        logoutResumeActive: latest.isActive !== false, loggedOutAt },
    });
    if (!updated) return { logoutRequested: true, localUpdated: false, warning: "退出请求已提交；本地账号已删除，未重新创建记录。" };
    return { logoutRequested: true, localUpdated: true };
  } catch {
    return { logoutRequested: true, localUpdated: false, warning: "OpenAI 已受理退出请求，但本地账号状态未能更新。请重新登录原账号。" };
  }
}

export function logoutCodexConnection(connectionId) {
  if (!pending.has(connectionId)) pending.set(connectionId, logout(connectionId).finally(() => pending.delete(connectionId)));
  return pending.get(connectionId);
}
