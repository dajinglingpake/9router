import os from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { NextResponse } from "next/server";
import { getActiveRequests, getUsageHistory, getRuntimeRequestErrors } from "@/lib/usageDb.js";
import fs from "node:fs/promises";
import { getTrafficSnapshot } from "@/lib/runtimeTraffic.js";
import { getConcurrencySnapshot } from "@/sse/services/concurrencyLimiter.js";
import { getProviderConnections, getApiKeys } from "@/lib/localDb";

export const dynamic = "force-dynamic";

async function getThreadCount() {
  try {
    const status = await fs.readFile("/proc/self/status", "utf8");
    return Number(status.match(/^Threads:\s+(\d+)/m)?.[1]) || null;
  } catch { return null; }
}

function getRuntimeConnectionStats() {
  if (typeof process._getActiveHandles !== "function") {
    return { networkConnections: null };
  }
  const handles = process._getActiveHandles();
  const networkConnections = handles.filter((handle) => handle?.constructor?.name === "Socket").length;
  return { networkConnections };
}

let previousCpu = null;
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
eventLoop.enable();

function getCpuMetrics() {
  const usage = process.cpuUsage();
  const cpus = os.cpus();
  const now = process.hrtime.bigint();
  if (!previousCpu) {
    previousCpu = { usage, now, cpus };
    return { processPercent: 0, systemPercent: 0, load1: os.loadavg()[0] || 0, cores: cpus.length };
  }

  const elapsedMicros = Number(now - previousCpu.now) / 1000;
  const cpuMicros = (usage.user - previousCpu.usage.user) + (usage.system - previousCpu.usage.system);
  const previousTotal = previousCpu.cpus.reduce((sum, cpu) => sum + Object.values(cpu.times).reduce((total, value) => total + value, 0), 0);
  const currentTotal = cpus.reduce((sum, cpu) => sum + Object.values(cpu.times).reduce((total, value) => total + value, 0), 0);
  const previousIdle = previousCpu.cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0);
  const currentIdle = cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0);
  previousCpu = { usage, now, cpus };
  const processPercent = elapsedMicros > 0 ? (cpuMicros / elapsedMicros) * 100 : 0;
  const totalDelta = currentTotal - previousTotal;
  const idleDelta = currentIdle - previousIdle;
  const systemPercent = totalDelta > 0 ? ((totalDelta - idleDelta) / totalDelta) * 100 : 0;
  return {
    processPercent: Math.round(processPercent * 10) / 10,
    systemPercent: Math.round(systemPercent * 10) / 10,
    load1: os.loadavg()[0] || 0,
    cores: cpus.length,
  };
}

export async function getSystemMetrics() {
  const active = await getActiveRequests();
  const history = await getUsageHistory({ startDate: new Date(Date.now() - 5 * 60 * 1000).toISOString() });
  const activeRequests = active.activeRequests || [];
  const concurrency = activeRequests.reduce((sum, request) => sum + (Number(request.count) || 0), 0);
  const requestItems = activeRequests.flatMap((request) => request.requests || []);
  const latencies = requestItems.map((request) => request.latencyMs).filter(Number.isFinite);
  const requestSummary = {
    activeRequests: requestItems.length || concurrency,
    models: new Set(activeRequests.map((request) => request.model)).size,
    apiKeys: new Set(requestItems.map((request) => request.apiKeyName).filter(Boolean)).size,
    clientIps: new Set(requestItems.map((request) => request.clientIp).filter(Boolean)).size,
    averageLatencyMs: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : 0,
    maxLatencyMs: latencies.length ? Math.max(...latencies) : 0,
    activeUploadBytes: requestItems.reduce((sum, request) => sum + (Number(request.requestBytes) || 0), 0),
  };
  const recentCount = history.length;
  const runtimeErrors = getRuntimeRequestErrors();
  const runtime4xx = runtimeErrors.filter((item) => /4\d\d/.test(item.status)).length;
  const runtime5xx = runtimeErrors.filter((item) => /5\d\d/.test(item.status)).length;
  const successful = history.filter((item) => !/^(error|failed)|4\d\d|5\d\d/i.test(String(item.status || ""))).length;
  const requestStats = {
    throughputPerMinute: Math.round(recentCount / 5 * 10) / 10,
    successRatePercent: recentCount + runtimeErrors.length ? Math.round(successful / (recentCount + runtimeErrors.length) * 1000) / 10 : 0,
    error4xx: history.filter((item) => /4\d\d/.test(String(item.status))).length + runtime4xx,
    error5xx: history.filter((item) => /5\d\d|error|failed/i.test(String(item.status))).length + runtime5xx,
  };
  const memory = process.memoryUsage();
  const cpu = getCpuMetrics();
  const runtimeConnections = getRuntimeConnectionStats();
  const rawConcurrency = getConcurrencySnapshot();
  const [connections, apiKeys] = await Promise.all([getProviderConnections(), getApiKeys()]);
  const labels = new Map([
    ...connections.map((item) => [`account:${item.id}`, `账号: ${item.name || item.email || item.id.slice(0, 8)}`]),
    ...apiKeys.map((item) => [`apiKey:${item.id}`, `API Key: ${item.name}`]),
  ]);
  const concurrencyLimits = rawConcurrency.map((item) => ({
    ...item,
    label: labels.get(`${item.scope}:${item.id}`) || `${item.scope}: ${item.id.slice(0, 8)}`,
    state: item.queued > 0 ? "queued" : "running",
  }));
  const systemTotal = os.totalmem();
  const systemFree = os.freemem();

  return {
    pid: process.pid,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    cpu,
    memory: {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      systemTotal,
      systemFree,
      systemUsedPercent: systemTotal ? Math.round(((systemTotal - systemFree) / systemTotal) * 1000) / 10 : 0,
    },
    eventLoop: {
      p50Ms: Math.round(eventLoop.percentile(50) / 1e6 * 10) / 10,
      p99Ms: Math.round(eventLoop.percentile(99) / 1e6 * 10) / 10,
      maxMs: Math.round(eventLoop.max / 1e6 * 10) / 10,
    },
    activeHandles: typeof process._getActiveHandles === "function" ? process._getActiveHandles().length : null,
    networkConnections: runtimeConnections.networkConnections,
    concurrency,
    requestSummary,
    traffic: getTrafficSnapshot(),
    concurrencyLimits,
    runtime: { threads: await getThreadCount() },
    requestStats: { ...requestStats, outputTokensPerSecond: undefined },
    activeRequests,
  };
}

export async function GET() {
  return NextResponse.json(await getSystemMetrics(), { headers: { "Cache-Control": "no-store" } });
}
