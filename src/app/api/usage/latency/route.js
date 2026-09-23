import { NextResponse } from "next/server";
import { getUsageLatencyByBucket } from "@/lib/usageDb";

const PERIOD_MS = { "24h": 24 * 60 * 60 * 1000, "7d": 7 * 24 * 60 * 60 * 1000, "30d": 30 * 24 * 60 * 60 * 1000, "60d": 60 * 24 * 60 * 60 * 1000 };

export const dynamic = "force-dynamic";

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

    const buckets = getBuckets(period);
    const summaries = await getUsageLatencyByBucket(buckets.start, buckets.size, buckets.count);
    const grouped = {};
    const modelSet = new Set();
    for (const summary of summaries) {
      modelSet.add(summary.model);
      grouped[`${summary.bucket}|${summary.model}`] = summary;
    }

    const models = [...modelSet].sort();
    const data = Array.from({ length: buckets.count }, (_, index) => {
      const point = { label: buckets.label(buckets.start + index * buckets.size), timestamp: buckets.start + index * buckets.size };
      for (const model of models) {
        const item = grouped[`${index}|${model}`];
        // Keep every bucket numeric so zero-latency periods remain visible on the zero axis.
        point[model] = item?.requests ? Math.round(item.totalLatency / item.requests) : 0;
      }
      return point;
    });
    return NextResponse.json({ models, data });
  } catch (error) {
    console.error("[API] Failed to get latency data:", error);
    return NextResponse.json({ error: "Failed to fetch latency data" }, { status: 500 });
  }
}
