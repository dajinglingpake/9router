import { getPlatformEstimateUsage } from "@/lib/db/repos/usageRepo.js";
import { getProviderConnections } from "@/lib/db/repos/connectionsRepo.js";
import { getAccountPlan } from "@/lib/accountPlan.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;
const TEST_NAME = "AI 测试费用";
const noStore = { "Cache-Control": "no-store" };

function dayString(milliseconds) {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function parseDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const day = Date.parse(value);
  return Number.isFinite(day) && dayString(day) === value ? day : null;
}

function getPeriod(params, today) {
  const month = params.get("month");
  if (params.has("startDate") || params.has("endDate")) {
    if (params.has("month")) return null;
    const start = parseDay(params.get("startDate"));
    const end = parseDay(params.get("endDate"));
    return start !== null && end !== null && start <= end ? { start, end } : null;
  }
  const requestedMonth = month ?? dayString(parseDay(today.slice(0, 7) + "-01") - DAY_MS).slice(0, 7);
  const start = parseDay(requestedMonth + "-01");
  if (start === null) return null;
  const next = new Date(start);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { start, end: next.getTime() - DAY_MS };
}

function collectByName(rows, excluded) {
  const names = new Map();
  const totals = { calls: 0, estimatedUsd: 0 };
  for (const row of rows) {
    if (excluded.has(row.provider)) continue;
    const name = !row.name || /(?:sk|rk|sess)-[a-zA-Z0-9_-]{8,}/i.test(row.name) ? TEST_NAME : row.name;
    if (!names.has(name)) names.set(name, { name, calls: 0, estimatedUsd: 0, byProvider: new Map() });
    const member = names.get(name);
    if (!member.byProvider.has(row.provider)) {
      member.byProvider.set(row.provider, { provider: row.provider, calls: 0, estimatedUsd: 0 });
    }
    for (const bucket of [totals, member, member.byProvider.get(row.provider)]) {
      bucket.calls += row.calls;
      bucket.estimatedUsd += row.estimatedUsd;
    }
  }
  const byName = [...names.values()]
    .sort((a, b) => b.estimatedUsd - a.estimatedUsd || b.calls - a.calls || a.name.localeCompare(b.name))
    .map(member => ({
      ...member,
      callShare: totals.calls ? member.calls / totals.calls : 0,
      estimatedCostShare: totals.estimatedUsd ? member.estimatedUsd / totals.estimatedUsd : 0,
      byProvider: [...member.byProvider.values()],
    }));
  return { totals, byName };
}

function countAccounts(connections) {
  const providers = new Map();
  for (const connection of connections) {
    const plan = connection.provider === "codex" ? getAccountPlan(connection).type : "any";
    if (!providers.has(connection.provider)) providers.set(connection.provider, {});
    const counts = providers.get(connection.provider);
    counts[plan] = (counts[plan] || 0) + 1;
  }
  return Object.fromEntries(providers);
}

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const today = dayString(Date.now() + CHINA_OFFSET_MS);
  const range = getPeriod(params, today);
  if (!range) {
    return Response.json({ error: "Use month (YYYY-MM) or both startDate and endDate (YYYY-MM-DD)." },
      { status: 400, headers: noStore });
  }
  try {
    const [rows, connections] = await Promise.all([
      getPlatformEstimateUsage(
        new Date(range.start - CHINA_OFFSET_MS).toISOString(),
        new Date(range.end + DAY_MS - CHINA_OFFSET_MS).toISOString(),
      ),
      getProviderConnections({ isActive: true }),
    ]);
    const period = { startDate: dayString(range.start), endDate: dayString(range.end), timeZone: "Asia/Shanghai" };
    const accountSnapshot = { date: today, activeByProvider: countAccounts(connections) };
    return Response.json({
      period, currency: "USD", ...collectByName(rows, new Set(params.getAll("excludeProvider"))), accountSnapshot,
    }, { headers: noStore });
  } catch (error) {
    console.error("[API] Failed to read platform estimates:", error);
    return Response.json({ error: "Failed to read platform estimates" }, { status: 500, headers: noStore });
  }
}
