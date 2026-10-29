import { createHash } from "node:crypto";
import OPENAI, { OPENAI_USAGE_CONFIG } from "open-sse/providers/registry/openai.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { estimateOpenAIUsage } from "./openaiUsageEstimate.js";

const usageCache = new Map();
const invalidData = () => new Error("OpenAI 用量接口返回的数据格式无效，请稍后重试。");
const number = value => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalidData();
  return value;
};

async function readUsagePages(endpoint, adminKey, startTime, endTime, proxyOptions, signal, groupBy = []) {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({ start_time: startTime, end_time: endTime, bucket_width: "1d", limit: OPENAI_USAGE_CONFIG.bucketLimit });
  for (const field of groupBy) url.searchParams.append("group_by", field);
  const results = [];
  const cursors = new Set();
  while (true) {
    let response;
    try {
      response = await proxyAwareFetch(url.toString(), {
        headers: { Authorization: `Bearer ${adminKey}`, Accept: "application/json" },
        cache: "no-store", redirect: "error", signal,
      }, { ...proxyOptions, signal });
    } catch {
      throw new Error(signal.aborted ? "OpenAI 用量查询已超时或取消，请稍后重试。" : "无法连接 OpenAI 用量接口，请检查账号代理设置。");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const messages = {
        401: "OpenAI Admin Key 无效或已过期，请在编辑账号中更新。",
        403: "OpenAI Admin Key 无权查询组织用量或费用，请检查权限。",
        429: "OpenAI 用量查询达到限流，请稍后刷新。",
      };
      throw new Error(messages[response.status] || `OpenAI 用量查询失败（HTTP ${response.status}）。`);
    }
    const data = await response.json().catch(() => { throw invalidData(); });
    if (!Array.isArray(data?.data)) throw invalidData();
    for (const bucket of data.data) {
      if (!Array.isArray(bucket?.results)) throw invalidData();
      results.push(...bucket.results);
    }
    if (!data.has_more) return results;
    if (typeof data.next_page !== "string" || !data.next_page || cursors.has(data.next_page)) throw invalidData();
    cursors.add(data.next_page);
    url.searchParams.set("page", data.next_page);
  }
}

export async function getOpenAIUsage(connection, proxyOptions = {}, { force = false } = {}) {
  const adminKey = connection.openaiAdminKey;
  if (!adminKey) return OPENAI.display.quotaNotice;
  const now = new Date();
  const startTime = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000;
  const endTime = Math.max(startTime + 1, Math.floor(now.getTime() / 1000));
  const { signal: callerSignal, ...proxy } = proxyOptions || {};
  // Never cache by the raw secret, or reuse results after changing credentials/proxy.
  const key = createHash("sha256").update(JSON.stringify([adminKey, proxy, startTime])).digest("hex");
  for (const [id, cached] of usageCache) if (cached.expiresAt <= Date.now()) usageCache.delete(id);
  if (!force && usageCache.has(key)) return usageCache.get(key).value;
  const timeout = AbortSignal.timeout(OPENAI_USAGE_CONFIG.timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  const [costRows, usageRows] = await Promise.all([
    readUsagePages(OPENAI_USAGE_CONFIG.costsUrl, adminKey, startTime, endTime, proxy, signal),
    readUsagePages(OPENAI_USAGE_CONFIG.completionsUrl, adminKey, startTime, endTime, proxy, signal, OPENAI_USAGE_CONFIG.groupBy),
  ]);
  const costs = new Map();
  for (const row of costRows) {
    const currency = row?.amount?.currency;
    if (typeof currency !== "string" || !/^[a-z]{3}$/i.test(currency)) throw invalidData();
    const unit = currency.toUpperCase();
    costs.set(unit, (costs.get(unit) || 0) + number(row.amount.value));
  }
  const sum = field => usageRows.reduce((total, row) => total + number(row?.[field]), 0);
  const value = {
    openaiUsage: {
      periodStart: new Date(startTime * 1000).toISOString(), periodEnd: new Date(endTime * 1000).toISOString(),
      costs: [...costs].map(([currency, amount]) => ({ currency, amount })),
      requests: sum("num_model_requests"), inputTokens: sum("input_tokens"), outputTokens: sum("output_tokens"),
      ...(costs.size === 0 ? { estimate: estimateOpenAIUsage(usageRows) } : {}),
    },
    detailUrl: OPENAI.display.quotaNotice.detailUrl,
  };
  usageCache.set(key, { value, expiresAt: Date.now() + OPENAI_USAGE_CONFIG.cacheTtlMs });
  return value;
}
