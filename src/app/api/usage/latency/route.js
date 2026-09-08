import { NextResponse } from "next/server";
import { getUsageHistory } from "@/lib/usageDb";

const PERIOD_MS = { "24h": 24 * 60 * 60 * 1000, "7d": 7 * 24 * 60 * 60 * 1000, "30d": 30 * 24 * 60 * 60 * 1000, "60d": 60 * 24 * 60 * 60 * 1000 };

export const dynamic = "force-dynamic";

function getStartDate(period) {
  if (period === "today") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return start.toISOString();
  }
  return new Date(Date.now() - (PERIOD_MS[period] || PERIOD_MS["24h"])).toISOString();
}

function getBuckets(period) {
  const now = Date.now();
  if (period === "today") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return { start: start.getTime(), size: 3600000, count: 24, label: (time) => new Date(time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }) };
  }
  if (period === "24h") return { start: now - PERIOD_MS[period], size: 3600000, count: 24, label: (time) => new Date(time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }) };
  const count = Number(period.replace("d", ""));
  return { start: now - PERIOD_MS[period], size: 86400000, count, label: (time) => new Date(time).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }) };
}

export async function GET(request) {
  try {
    const period = new URL(request.url).searchParams.get("period") || "24h";
    if (period !== "today" && !PERIOD_MS[period]) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    const details = await getUsageHistory({ startDate: getStartDate(period) });
    const buckets = getBuckets(period);
    const grouped = {};
    const modelSet = new Set();
    for (const detail of details) {
      if (detail.model) modelSet.add(detail.model);
      const total = Number(detail.latency?.total);
      if (!Number.isFinite(total) || total < 0 || !detail.model) continue;
      const timestamp = new Date(detail.timestamp).getTime();
      const index = Math.floor((timestamp - buckets.start) / buckets.size);
      if (index < 0 || index >= buckets.count) continue;
      const key = `${index}|${detail.model}`;
      const item = grouped[key] ||= { index, model: detail.model, requests: 0, totalLatency: 0 };
      item.requests += 1;
      item.totalLatency += total;
    }

    const models = [...modelSet].sort();
    const data = Array.from({ length: buckets.count }, (_, index) => {
      const point = { label: buckets.label(buckets.start + index * buckets.size), timestamp: buckets.start + index * buckets.size };
      for (const model of models) {
        const item = grouped[`${index}|${model}`];
        // Keep every bucket numeric so zero-latency periods remain visible on the zero axis.
        point[model] = item ? Math.round(item.totalLatency / item.requests) : 0;
      }
      return point;
    });
    return NextResponse.json({ models, data });
  } catch (error) {
    console.error("[API] Failed to get latency data:", error);
    return NextResponse.json({ error: "Failed to fetch latency data" }, { status: 500 });
  }
}
