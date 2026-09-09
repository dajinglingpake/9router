import os from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { NextResponse } from "next/server";
import { getActiveRequests } from "@/lib/usageDb.js";

export const dynamic = "force-dynamic";

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
  const activeRequests = active.activeRequests || [];
  const concurrency = activeRequests.reduce((sum, request) => sum + (Number(request.count) || 0), 0);
  const memory = process.memoryUsage();
  const cpu = getCpuMetrics();
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
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
      systemTotal,
      systemFree,
      systemUsedPercent: systemTotal ? Math.round(((systemTotal - systemFree) / systemTotal) * 1000) / 10 : 0,
    },
    eventLoop: { p50Ms: Math.round(eventLoop.percentile(50) / 1e6 * 10) / 10, p99Ms: Math.round(eventLoop.percentile(99) / 1e6 * 10) / 10, maxMs: Math.round(eventLoop.max / 1e6 * 10) / 10 },
    activeHandles: typeof process._getActiveHandles === "function" ? process._getActiveHandles().length : null,
    concurrency,
    activeRequests,
  };
}

export async function GET() {
  return NextResponse.json(await getSystemMetrics(), { headers: { "Cache-Control": "no-store" } });
}
