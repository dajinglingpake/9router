import { createHash } from "node:crypto";
import { calculateCostFromTokens, MODEL_PRICING } from "open-sse/providers/pricing.js";
import OPENAI, { OPENAI_USAGE_CONFIG } from "open-sse/providers/registry/openai.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { getPricing } from "./db/repos/pricingRepo.js";
import { getUsageHistory } from "./db/repos/usageRepo.js";
import { estimateOpenAIUsage, getOpenAIBaseModel } from "./openaiUsageEstimate.js";

const usageCache = new Map();
const invalidData = () => new Error("OpenAI 用量接口返回的数据格式无效，请稍后重试。");
const number = value => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalidData();
  return value;
};

function formatBalance(balance, source, usage) {
  const spent = usage.estimate?.amount;
  return { ...balance, source, currency: "USD", ...usage, remaining: spent == null ? null : balance.amount - spent };
}

async function getLocalOpenAIBalance(connection) {
  const balance = connection.openaiBalance;
  const readError = { error: "无法读取 9Router 用量记录，请稍后刷新。" };
  if (!connection.id) return formatBalance(balance, "local", readError);
  try {
    const rows = await getUsageHistory({ provider: "openai", connectionId: connection.id, startDate: balance.recordedAt });
    const prices = rows.length ? (await getPricing()).openai : null;
    let amount = 0;
    let unpricedRequests = 0;
    for (const row of rows) {
      // Reprice older rows whose cost was saved before the model had a price.
      const baseModel = getOpenAIBaseModel(row.model);
      const pricing = prices?.[row.model] ?? prices?.[baseModel] ?? (Object.hasOwn(MODEL_PRICING, baseModel) ? MODEL_PRICING[baseModel] : null);
      const cost = row.cost > 0 ? row.cost : calculateCostFromTokens(row.tokens, pricing);
      if (Number.isFinite(cost) && cost > 0) amount += cost;
      else unpricedRequests++;
    }
    return formatBalance(balance, "local", {
      estimate: { amount: rows.length === 0 || unpricedRequests < rows.length ? amount : null, unpricedRequests, requests: rows.length },
    });
  } catch {
    return formatBalance(balance, "local", readError);
  }
}

export async function getLocalOpenAIUsage(connection, message = OPENAI.display.quotaNotice.message) {
  return {
    ...OPENAI.display.quotaNotice, message,
    ...(connection.openaiBalance ? { openaiUsage: { balance: await getLocalOpenAIBalance(connection) } } : {}),
  };
}

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
      for (const row of bucket.results) {
        results.push(groupBy.length && row ? { ...row, bucketStartTime: bucket.start_time ?? startTime } : row);
      }
    }
    if (!data.has_more) return results;
    if (typeof data.next_page !== "string" || !data.next_page || cursors.has(data.next_page)) throw invalidData();
    cursors.add(data.next_page);
    url.searchParams.set("page", data.next_page);
  }
}

export async function getOpenAIUsage(connection, proxyOptions = {}, { force = false } = {}) {
  const adminKey = connection.openaiAdminKey;
  if (!adminKey) return getLocalOpenAIUsage(connection);
  const now = new Date();
  const startTime = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000;
  const endTime = Math.max(startTime + 1, Math.floor(now.getTime() / 1000));
  // Costs only include complete UTC buckets; include today's bucket through midnight.
  const costsEndTime = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) / 1000;
  const balance = connection.openaiBalance;
  const balanceStartTime = balance ? Math.ceil(Date.parse(balance.recordedAt) / 1000) : null;
  const { signal: callerSignal, ...proxy } = proxyOptions || {};
  // Never cache by the raw secret, or reuse results after changing credentials/proxy.
  const key = createHash("sha256").update(JSON.stringify([connection.id, adminKey, proxy, startTime, balance])).digest("hex");
  for (const [id, cached] of usageCache) if (cached.expiresAt <= Date.now()) usageCache.delete(id);
  if (!force && usageCache.has(key)) return usageCache.get(key).value;
  const timeout = AbortSignal.timeout(OPENAI_USAGE_CONFIG.timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  const [costRows, usageRows, balanceUsage] = await Promise.all([
    readUsagePages(OPENAI_USAGE_CONFIG.costsUrl, adminKey, startTime, costsEndTime, proxy, signal),
    readUsagePages(OPENAI_USAGE_CONFIG.completionsUrl, adminKey, startTime, endTime, proxy, signal, OPENAI_USAGE_CONFIG.groupBy),
    balance && balanceStartTime < endTime
      ? readUsagePages(OPENAI_USAGE_CONFIG.completionsUrl, adminKey, balanceStartTime, endTime, proxy, signal, OPENAI_USAGE_CONFIG.groupBy)
        .then(rows => ({ estimate: estimateOpenAIUsage(rows) }))
        .catch(error => ({ error: error.message }))
      : { estimate: estimateOpenAIUsage([]) },
  ]);
  const costs = new Map();
  for (const row of costRows) {
    const currency = row?.amount?.currency;
    if (typeof currency !== "string" || !/^[a-z]{3}$/i.test(currency)) throw invalidData();
    const unit = currency.toUpperCase();
    costs.set(unit, (costs.get(unit) || 0) + number(row.amount.value));
  }
  const sum = field => usageRows.reduce((total, row) => total + number(row?.[field]), 0);
  let estimatedBalance = balance ? formatBalance(balance, "organization", balanceUsage) : null;
  if (balance && connection.id && (balanceUsage.error || balanceUsage.estimate.breakdown.length === 0)) {
    const local = await getLocalOpenAIBalance(connection);
    if (balanceUsage.error || (local.estimate?.requests > 0 && local.remaining != null)) {
      estimatedBalance = { ...local, error: local.error ?? balanceUsage.error };
    }
  }
  const value = {
    openaiUsage: {
      periodStart: new Date(startTime * 1000).toISOString(), periodEnd: new Date(endTime * 1000).toISOString(),
      costs: [...costs].map(([currency, amount]) => ({ currency, amount })),
      requests: sum("num_model_requests"), inputTokens: sum("input_tokens"), outputTokens: sum("output_tokens"),
      ...(costs.size === 0 ? { estimate: estimateOpenAIUsage(usageRows) } : {}),
      ...(estimatedBalance ? { balance: estimatedBalance } : {}),
    },
    detailUrl: OPENAI.display.quotaNotice.detailUrl,
  };
  if (!balanceUsage.error && estimatedBalance?.source !== "local") {
    usageCache.set(key, { value, expiresAt: Date.now() + OPENAI_USAGE_CONFIG.cacheTtlMs });
  }
  return value;
}
