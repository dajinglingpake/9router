import { createHash } from "node:crypto";
import { getAdapter } from "./db/driver.js";
import { parseJson } from "./db/helpers/jsonCol.js";
import { getRequestErrorInfo } from "./requestErrorInfo.js";
import { getExclusiveApiKeyIds } from "@/shared/utils/accountApiKeyBindings.js";
import { buildDiagnosticsReport } from "@/shared/utils/requestDiagnostics.js";
import { getRequestPressureSignal } from "./requestPressureSignals.cjs";
import { DIAGNOSTIC_TOKEN_COLUMNS, extractDiagnosticTokenUsage } from "./diagnosticTokenUsage.cjs";
import { ACCOUNT_QUALITY_MAX_LENGTH, getAccountQualityMetadata, isAccountQualityColor } from "@/shared/utils/accountQuality.js";
import { getAccountPlan } from "./accountPlan.js";
import { getCodexTrialIdentity } from "@/shared/utils/codexTrialIdentity.js";
import { safeDiagnosticMessage } from "open-sse/utils/upstreamDiagnostics.js";

const MAX_ROWS = 20000;
const valueOrNull = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export function parseDiagnosticsQuery(params, now = Date.now()) {
  const end = params.has("end") ? new Date(params.get("end")).getTime() : now;
  const start = params.has("start") ? new Date(params.get("start")).getTime() : end - 6 * 3600000;
  const slowMs = params.has("slowMs") ? Number(params.get("slowMs")) : 60000;
  const page = params.has("page") ? Number(params.get("page")) : 1;
  const issue = params.get("issue") || "all";
  const accountLabel = params.get("accountLabel") || "all";
  const accountColor = params.get("accountColor") || "all";
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error("请选择有效的起止时间，结束时间须晚于开始时间。");
  if (end - start > 31 * 86400000) throw new Error("单次最多查询 31 天，请缩短时间范围。");
  if (!Number.isFinite(slowMs) || slowMs < 1000 || slowMs > 3600000) throw new Error("慢响应阈值须在 1–3600 秒之间。");
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("页码无效。");
  if (!["all", "error", "slow", "overload", "success", "cancelled"].includes(issue)) throw new Error("请求状态无效。");
  if (params.get("focusApiKeyId") && params.get("focusConnectionId")) throw new Error("一次只能关注一个账号或 API Key。");
  if (!["all", "marked", "unmarked"].includes(accountLabel) && !(accountLabel.startsWith("label:") && accountLabel.slice(6).trim() && accountLabel.slice(6).length <= ACCOUNT_QUALITY_MAX_LENGTH)) throw new Error("账号标签筛选无效。");
  if (accountColor !== "all" && !isAccountQualityColor(accountColor)) throw new Error("标签颜色筛选无效。");
  return { start, end, slowMs, page, pageSize: 20, issue,
    detailsOnly: params.get("detailsOnly") === "1", includeAnalysis: params.get("analysis") !== "0",
    accountLabel: accountLabel.startsWith("label:") ? `label:${accountLabel.slice(6).trim()}` : accountLabel, accountColor: accountColor.toLowerCase(),
    focusApiKeyId: params.get("focusApiKeyId") || null, focusConnectionId: params.get("focusConnectionId") || null,
    provider: params.get("provider") || "all", model: params.get("model") || "all",
    apiKeyId: params.get("apiKeyId") || null, connectionId: params.get("connectionId") || null };
}

export async function getRequestDiagnostics(options) {
  const db = await getAdapter();
  const keys = db.all("SELECT id, name, key FROM apiKeys");
  const keyByValue = new Map(keys.map(k => [k.key, k]));
  const keyById = new Map(keys.map(k => [k.id, k]));
  const connections = db.all(`SELECT id, provider, name, email,
    CASE WHEN json_valid(data) THEN json_extract(data, '$.idToken') END AS idToken,
    CASE WHEN json_valid(data) THEN json_extract(data, '$.accessToken') END AS accessToken,
    CASE WHEN json_valid(data) THEN data -> '$.providerSpecificData.chatgptPlanType' END AS chatgptPlanType,
    CASE WHEN json_valid(data) THEN data -> '$.qualityStatus' END AS qualityStatus,
    CASE WHEN json_valid(data) THEN data -> '$.qualityLabel' END AS qualityLabel,
    CASE WHEN json_valid(data) THEN data -> '$.qualityColor' END AS qualityColor,
    CASE WHEN json_valid(data) THEN data -> '$.qualityMarkedAt' END AS qualityMarkedAt,
    CASE WHEN json_valid(data) THEN data -> '$.isDegraded' END AS isDegraded,
    CASE WHEN json_valid(data) THEN data -> '$.degradedMarkedAt' END AS degradedMarkedAt,
    CASE WHEN json_valid(data) THEN json_extract(data, '$.exclusiveApiKeyIds') END AS bindings,
    CASE WHEN json_valid(data) THEN json_extract(data, '$.exclusiveApiKeyId') END AS binding
    FROM providerConnections`).map(c => {
    const ids = getExclusiveApiKeyIds({ exclusiveApiKeyIds: parseJson(c.bindings), exclusiveApiKeyId: c.binding });
    const accountPlan = getAccountPlan({ provider: c.provider, idToken: c.idToken, accessToken: c.accessToken,
      providerSpecificData: { chatgptPlanType: parseJson(c.chatgptPlanType) } });
    return { id: c.id, provider: c.provider, name: c.name || c.email || c.id.slice(0, 8), exclusiveApiKeyIds: ids,
      ...(accountPlan ? { accountPlan } : {}),
      ...getAccountQualityMetadata({ qualityStatus: c.qualityStatus === null ? undefined : parseJson(c.qualityStatus),
        qualityLabel: parseJson(c.qualityLabel), qualityColor: parseJson(c.qualityColor), qualityMarkedAt: parseJson(c.qualityMarkedAt),
        isDegraded: parseJson(c.isDegraded) === true, degradedMarkedAt: parseJson(c.degradedMarkedAt) }),
      exclusiveApiKeyNames: ids.map(id => keyById.get(id)?.name || "已删除 Key") };
  });
  const accountMap = new Map(connections.map(c => [c.id, c]));
  const historyStart = options.detailsOnly || options.includeAnalysis === false ? options.start : options.start - 7 * 86400000;
  const start = new Date(historyStart).toISOString(), end = new Date(options.end).toISOString();
  const providerClause = options.provider && options.provider !== "all" ? " AND provider = ?" : "";
  const providerParams = providerClause ? [options.provider] : [];
  // Details do not need peer comparisons or the seven-day waiting baseline.
  const detailFilters = options.detailsOnly ? [
    ["connectionId", options.focusConnectionId], ["connectionId", options.connectionId],
    ["model", options.model !== "all" ? options.model : null],
  ].filter(([, value]) => value) : [];
  const detailClause = detailFilters.map(([column]) => ` AND ${column} = ?`).join("");
  const detailParams = detailFilters.map(([, value]) => value);
  // Keep disk reads inside the selected time window. SQLite otherwise prefers the
  // account/provider index and reads its entire history before filtering and sorting.
  const usage = db.all(`SELECT id, timestamp, provider, model, connectionId, apiKey, endpoint, clientIp, status, promptTokens, completionTokens,
    CASE WHEN json_valid(meta) THEN json_extract(meta, '$.latency.total') END AS latencyMs,
    CASE WHEN json_valid(meta) THEN json_extract(meta, '$.latency.ttft') END AS ttftMs,
    ${DIAGNOSTIC_TOKEN_COLUMNS}
    FROM usageHistory INDEXED BY idx_uh_ts WHERE timestamp >= ? AND timestamp < ?${providerClause}${detailClause} ORDER BY timestamp DESC, id DESC LIMIT ?`, [start, end, ...providerParams, ...detailParams, MAX_ROWS + 1]);
  const errors = db.all(`SELECT id, timestamp, connectionId, provider, model, requestId, retryCount, recovered, data
    FROM requestErrors INDEXED BY idx_re_ts WHERE timestamp >= ? AND timestamp < ?${providerClause}${detailClause} ORDER BY timestamp DESC, id DESC LIMIT ?`, [options.start, options.end, ...providerParams, ...detailParams, MAX_ROWS + 1]);

  function identity(connectionId, key) {
    return { connectionId: connectionId || "unrouted", accountName: accountMap.get(connectionId)?.name || (connectionId ? "已删除账号" : "未路由到账号"),
      apiKeyId: key?.id || "unattributed", apiKeyName: key?.name || "未记录 API Key" };
  }
  const samples = usage.slice(0, MAX_ROWS).map(r => {
    const key = getCodexTrialIdentity(r.apiKey) || keyByValue.get(r.apiKey) || (r.apiKey ? { id: "deleted-" + createHash("sha256").update(r.apiKey).digest("hex").slice(0, 16), name: "已删除 API Key" } : null);
    const info = getRequestErrorInfo(r);
    const latencyMs = valueOrNull(r.latencyMs), rawTtft = valueOrNull(r.ttftMs);
    // Legacy full-response and missing-first-chunk timings equal total; exclude them from first-packet statistics.
    const ttftMs = rawTtft !== null && latencyMs !== null && rawTtft < latencyMs ? rawTtft : null;
    return { id: `usage-${r.id}`, timestamp: new Date(r.timestamp).getTime(), provider: r.provider || "unknown", model: r.model || "—",
      ...identity(r.connectionId, key), kind: info ? info.category === "cancelled" ? "cancelled" : "error" : "success",
      latencyMs, ttftMs, ...extractDiagnosticTokenUsage(r), firstPacketTiming: ttftMs === null ? "unavailable" : "legacy_first_chunk",
      statusCode: info?.statusCode || null, message: info?.summary || "请求成功完成", source: "upstream",
      recovered: false, retryCount: 0, requestId: null, endpoint: r.endpoint, clientIp: r.clientIp };
  });
  const attempts = new Map();
  for (const r of errors.slice(0, MAX_ROWS)) {
    const data = parseJson(r.data, {}) || {};
    const info = getRequestErrorInfo(data) || { summary: "请求处理失败", statusCode: null };
    const key = getCodexTrialIdentity(data.apiKeyId, data.apiKeyName) || keyById.get(data.apiKeyId) || (data.apiKeyId ? { id: data.apiKeyId, name: data.apiKeyName || "已删除 API Key" } : null);
    const signal = getRequestPressureSignal(data);
    const attemptId = r.requestId ? JSON.stringify([r.requestId, r.connectionId, r.model, r.retryCount, data.sseAttempt || 1, data.attempt || 1, data.source, info.statusCode]) : `error-${r.id}`;
    const previous = attempts.get(attemptId);
    if (previous) { previous.recovered ||= !!r.recovered; continue; }
    attempts.set(attemptId, { id: `error-${r.id}`, timestamp: r.timestamp, provider: r.provider || "unknown", model: r.model || "—",
      ...identity(r.connectionId, key), kind: info.category === "cancelled" ? "cancelled" : "error",
      latencyMs: valueOrNull(data.latencyMs), ttftMs: null, statusCode: info.statusCode, message: info.summary,
      pressureSignal: signal === "unknown" ? data.pressureSignal || "unknown" : signal,
      upstreamStatus: valueOrNull(data.upstreamStatus), queueWaitMs: valueOrNull(data.waitMs),
      queueTimedOut: data.source === "router" && data.message === "Concurrency queue wait timed out",
      source: data.source || "upstream", recovered: !!r.recovered, retryCount: r.retryCount,
      requestId: r.requestId, endpoint: data.endpoint || null, clientIp: data.clientIp || null });
  }
  samples.push(...attempts.values());
  const report = buildDiagnosticsReport(samples, options, connections, keys);
  // Return saved error text only for the displayed page, never in aggregate statistics.
  const detailIds = new Set(report.details.map(record => record.id));
  const rawMessages = new Map(errors.filter(row => detailIds.has(`error-${row.id}`)).map(row => {
    const message = parseJson(row.data, {})?.message;
    return [`error-${row.id}`, typeof message === "string" ? safeDiagnosticMessage(message) : null];
  }));
  return { ...report, details: report.details.map(record => ({ ...record, rawMessage: rawMessages.get(record.id) || null })),
    providers: [...new Set([...connections.map(c => c.provider), ...samples.map(r => r.provider)])].sort(),
    source: { kind: "live" },
    generatedAt: Date.now(), truncated: usage.length > MAX_ROWS || errors.length > MAX_ROWS,
    rowLimit: MAX_ROWS, mode: "live" };
}
