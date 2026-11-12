import { fetchWithTimeout, U } from "./shared.js";

const MICRODOLLARS_PER_USD = 1_000_000;

async function fetchProfileData(url, headers, proxyOptions) {
  try {
    const response = await fetchWithTimeout(url, { headers, redirect: "error", cache: "no-store" }, 10_000, proxyOptions);
    if (!response.ok) return { error: `HTTP ${response.status}` };
    return { data: await response.json() };
  } catch {
    return { error: "请求失败" };
  }
}

function getDailyUsage(rows, date) {
  if (!Array.isArray(rows) || rows.some(row => typeof row?.date !== "string")) return null;
  let requests = 0;
  let microdollars = 0;
  const models = [];
  for (const row of rows) {
    if (row.date !== date) continue;
    if (!Number.isSafeInteger(row.request_count) || row.request_count < 0 || !Number.isFinite(row.total_cost)) return null;
    requests += row.request_count;
    microdollars += row.total_cost;
    models.push({
      model: row.model || "未标明模型",
      requests: row.request_count,
      costUsd: row.total_cost / MICRODOLLARS_PER_USD,
      inputTokens: row.total_input_tokens,
      outputTokens: row.total_output_tokens,
    });
  }
  return { date, requests, costUsd: microdollars / MICRODOLLARS_PER_USD, models };
}

export async function getKiloUsage(accessToken, providerSpecificData, proxyOptions) {
  if (!accessToken) return { message: "请重新登录 Kilo Code 以获取余额和用量。" };
  const { balanceUrl, usageUrl, dashboardUrl, freeLimitReference } = U("kilocode");
  const orgId = providerSpecificData?.orgId;
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
  if (orgId) headers["X-KiloCode-OrganizationId"] = orgId;
  const url = new URL(usageUrl);
  // The report accepts week/month/year/all and returns UTC day buckets.
  url.search = new URLSearchParams({ period: "week", groupByModel: "true", viewType: orgId || "personal" });
  const date = new Date().toISOString().slice(0, 10);
  const [balance, report] = await Promise.all([
    fetchProfileData(balanceUrl, headers, proxyOptions),
    fetchProfileData(url.href, headers, proxyOptions),
  ]);

  const amount = balance.data?.balance; // Already USD, unlike the usage report.
  const daily = getDailyUsage(report.data?.usage, date);
  const warnings = [];
  const quotas = {};
  if (Number.isFinite(amount)) {
    quotas["付费可用余额"] = { used: 0, total: amount, isCreditBalance: true, currency: "USD" };
  } else {
    warnings.push(`无法读取 Kilo 余额（${balance.error || "响应缺少有效余额"}）`);
  }
  if (!daily) warnings.push(`无法读取 Kilo 用量（${report.error || "用量数据格式异常"}）`);
  if (!Number.isFinite(amount) && !daily) return { message: warnings.join(" · ") };

  return {
    quotas,
    kiloUsage: {
      daily,
      warning: warnings.join(" · "),
      freeLimitReference,
      detailUrl: orgId ? `${dashboardUrl}/organizations/${encodeURIComponent(orgId)}/usage-details` : `${dashboardUrl}/usage`,
    },
  };
}
