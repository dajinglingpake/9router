"use client";

import { useEffect, useMemo, useState } from "react";
import Card from "@/shared/components/Card";

const formatBytes = (bytes = 0) => {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const formatUptime = (seconds = 0) => {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days}d ${hours}h` : `${hours}h ${minutes}m`;
};

const formatLatency = (milliseconds) => {
  if (milliseconds == null) return "等待响应";
  if (milliseconds < 1000) return `${milliseconds} ms`;
  return `${(milliseconds / 1000).toFixed(1)} s`;
};


function MetricCard({ icon, label, value, detail, tone = "text-primary" }) {
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</p>
          <p className={`mt-2 text-2xl font-semibold tabular-nums ${tone}`}>{value}</p>
          <p className="mt-1 text-xs text-text-muted">{detail}</p>
        </div>
        <span className="material-symbols-outlined rounded-lg bg-bg p-2 text-xl text-text-muted" aria-hidden="true">{icon}</span>
      </div>
    </Card>
  );
}

export default function SystemMetrics({ initialMetrics = null }) {
  const [metrics, setMetrics] = useState(initialMetrics);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);

  useEffect(() => {
    let active = true;
    let retryTimer = null;
    let quickRetryDone = false;
    const load = async () => {
      if (active) setRefreshing(true);
      try {
        const response = await fetch("/api/system/metrics", { cache: "no-store" });
        if (response.status === 401) {
          await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
          window.location.assign("/login");
          return;
        }
        if (!response.ok) throw new Error("Metrics unavailable");
        const next = await response.json();
        if (active) { setMetrics(next); setError(""); }
      } catch (err) {
        if (active) {
          setError(err.message || "Metrics unavailable");
          // Retry quickly after the initial hydration/network race instead of
          // waiting for the regular polling interval.
          if (!quickRetryDone) {
            quickRetryDone = true;
            retryTimer = setTimeout(() => { retryTimer = null; load(); }, 250);
          }
        }
      } finally {
        if (active) setRefreshing(false);
      }
    };
    load();
    const timer = autoRefresh ? setInterval(load, 3000) : null;
    return () => { active = false; if (timer) clearInterval(timer); if (retryTimer) clearTimeout(retryTimer); };
  }, [refreshTick, autoRefresh]);

  const memoryPercent = useMemo(() => {
    if (!metrics?.memory?.systemTotal) return 0;
    return Math.round((1 - metrics.memory.systemFree / metrics.memory.systemTotal) * 100);
  }, [metrics]);

  const processMemory = metrics?.memory?.rss || 0;
  const processMemoryPercent = metrics?.memory?.systemTotal
    ? Math.round((processMemory / metrics.memory.systemTotal) * 1000) / 10
    : 0;
  const activeRequests = metrics?.activeRequests || [];
  const concurrencyLimits = metrics?.concurrencyLimits || [];
  const queuedLimits = concurrencyLimits.filter((item) => item.queued > 0);

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">Runtime monitor</p>
          <h1 className="mt-1 text-2xl font-semibold text-text-main">运行状态</h1>
          <p className="mt-1 text-sm text-text-muted">实时查看进程资源占用与请求并发情况</p>
        </div>
        <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
          <span className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full px-3 py-1.5 text-xs ${error ? "bg-red-500/10 text-red-600" : autoRefresh ? "bg-emerald-500/10 text-emerald-600" : "bg-bg text-text-muted"}`}>
            <span className={`h-2 w-2 rounded-full ${error ? "bg-red-500" : autoRefresh ? "bg-emerald-500" : "bg-text-muted"}`} />
            {error || (autoRefresh ? "每 3 秒更新" : "自动刷新已关闭")}
          </span>
          <button type="button" onClick={() => setRefreshTick((value) => value + 1)} disabled={refreshing} className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-border-subtle bg-surface px-3 text-xs font-medium text-text-main transition-colors hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50" aria-label="刷新运行状态">
            <span className={`material-symbols-outlined text-base ${refreshing ? "animate-spin" : ""}`} aria-hidden="true">refresh</span>
            刷新
          </button>
          <button type="button" role="switch" aria-checked={autoRefresh} aria-label={autoRefresh ? "关闭自动刷新" : "开启自动刷新"} onClick={() => setAutoRefresh((value) => !value)} className="inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border border-border-subtle bg-surface px-3 text-xs font-medium text-text-main transition-colors hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" title={autoRefresh ? "关闭自动刷新" : "开启自动刷新"}>
            <span className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${autoRefresh ? "bg-primary" : "bg-text-muted/40"}`} aria-hidden="true">
              <span className={`absolute top-0.5 z-10 h-3 w-3 rounded-full bg-white shadow-sm transition-[left] duration-200 ${autoRefresh ? "left-3.5" : "left-0.5"}`} />
            </span>
            自动刷新
          </button>
        </div>
      </div>

      <section aria-labelledby="resource-metrics-title">
        <h2 id="resource-metrics-title" className="mb-3 text-sm font-semibold text-text-main">资源占用</h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon="speed" label="系统 CPU" value={metrics ? `${metrics.cpu.systemPercent.toFixed(1)}%` : "—"} detail={metrics ? `负载 ${metrics.cpu.load1.toFixed(2)} · ${metrics.cpu.cores} 核` : "正在读取"} />
        <MetricCard icon="developer_board" label="进程 CPU" value={metrics ? `${metrics.cpu.processPercent.toFixed(1)}%` : "—"} detail={metrics ? `PID ${metrics.pid}` : "正在读取"} tone="text-blue-600" />
        <MetricCard icon="memory" label="系统内存" value={metrics ? `${memoryPercent}%` : "—"} detail={metrics ? `已用 ${formatBytes(metrics.memory.systemTotal - metrics.memory.systemFree)} / ${formatBytes(metrics.memory.systemTotal)}` : "正在读取"} tone="text-amber-600" />
        <MetricCard icon="memory_alt" label="进程内存" value={metrics ? formatBytes(processMemory) : "—"} detail={metrics ? `占系统 ${processMemoryPercent}% · Heap ${formatBytes(metrics.memory.heapUsed)} / ${formatBytes(metrics.memory.heapTotal)}` : "正在读取"} tone="text-orange-600" />
        <MetricCard icon="timer" label="运行时长" value={metrics ? formatUptime(metrics.uptimeSeconds) : "—"} detail={metrics ? `更新于 ${new Date(metrics.timestamp).toLocaleTimeString()}` : "正在读取"} tone="text-emerald-600" />
        <MetricCard icon="bolt" label="事件循环 P99" value={metrics ? `${metrics.eventLoop.p99Ms} ms` : "—"} detail={metrics ? `P50 ${metrics.eventLoop.p50Ms} ms · 峰值 ${metrics.eventLoop.maxMs} ms` : "正在读取"} tone="text-rose-600" />
        <MetricCard icon="account_tree" label="活动句柄" value={metrics?.activeHandles ?? "—"} detail={metrics ? `${metrics.node} · ${metrics.platform}` : "正在读取"} tone="text-cyan-600" />
        <MetricCard icon="view_module" label="进程线程数" value={metrics?.runtime?.threads ?? "—"} detail="Node.js 进程线程" tone="text-violet-600" />
        </div>
      </section>

      <section aria-labelledby="traffic-metrics-title">
        <h2 id="traffic-metrics-title" className="mb-3 text-sm font-semibold text-text-main">流量与请求</h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard icon="lan" label="当前并发" value={metrics ? metrics.requestSummary.activeRequests : "—"} detail={metrics ? `${metrics.requestSummary.models} 个模型 · ${metrics.requestSummary.clientIps} 个 IP` : "正在读取"} tone="text-blue-600" />
          <MetricCard icon="key" label="调用方 API Key" value={metrics ? metrics.requestSummary.apiKeys : "—"} detail="当前活跃请求涉及的 Key 数" tone="text-amber-600" />
          <MetricCard icon="speed" label="平均请求延迟" value={metrics ? formatLatency(metrics.requestSummary.averageLatencyMs) : "—"} detail={metrics ? `最长 ${formatLatency(metrics.requestSummary.maxLatencyMs)}` : "正在读取"} tone="text-rose-600" />
          <MetricCard icon="data_object" label="活跃请求体" value={metrics ? formatBytes(metrics.requestSummary.activeUploadBytes) : "—"} detail="当前进行中请求的请求体总大小" tone="text-cyan-600" />
          <MetricCard icon="upload" label="上行总流量" value={metrics ? formatBytes(metrics.traffic.uploadBytes) : "—"} detail="客户端请求进入路由器的累计流量" tone="text-blue-600" />
          <MetricCard icon="speed" label="上行实时速率" value={metrics ? `${formatBytes(metrics.traffic.uploadRateBytesPerSecond)}/s` : "—"} detail="最近 10 秒平均" tone="text-cyan-600" />
          <MetricCard icon="download" label="下行总流量" value={metrics ? formatBytes(metrics.traffic.downloadBytes) : "—"} detail="上游响应返回客户端的累计流量" tone="text-emerald-600" />
          <MetricCard icon="speed" label="下行实时速率" value={metrics ? `${formatBytes(metrics.traffic.downloadRateBytesPerSecond)}/s` : "—"} detail="最近 10 秒平均" tone="text-teal-600" />
          <MetricCard icon="trending_up" label="请求吞吐率" value={metrics ? `${metrics.requestStats.throughputPerMinute} req/min` : "—"} detail="5 min average" tone="text-blue-600" />
          <MetricCard icon="check_circle" label="请求成功率" value={metrics ? `${metrics.requestStats.successRatePercent}%` : "—"} detail={metrics ? `客户端错误 ${metrics.requestStats.error4xx} · 服务端错误 ${metrics.requestStats.error5xx}` : "正在读取"} tone="text-emerald-600" />
          <MetricCard icon="speed" label="实时输出速度" value={`${metrics?.traffic?.outputTokensPerSecond || 0} tokens/s`} detail="最近 10 秒流式输出估算" tone="text-amber-600" />
          <MetricCard icon="wifi" label="网络连接数" value={metrics?.networkConnections ?? "—"} detail="当前活动 Socket 连接" tone="text-cyan-600" />
        </div>
      </section>

      <Card title="活跃请求" subtitle="按模型与提供商聚合的当前请求">
        {activeRequests.length === 0 && queuedLimits.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border-subtle px-4 py-10 text-center text-sm text-text-muted">当前没有进行中的请求</div>
        ) : (
          <div className="divide-y divide-border-subtle">
            {activeRequests.map((request) => (
              (() => {
                const limit = concurrencyLimits.find((item) => item.scope === "account" && item.label === `账号: ${request.account}`);
                return (
              <div key={`${request.model}-${request.provider}-${request.account}`} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text-main">{request.model}</p>
                  <p className="text-xs text-text-muted">{request.provider} · {request.account}</p>
                  {limit && <p className={limit.queued > 0 ? "mt-1 text-xs text-amber-600" : "mt-1 text-xs text-emerald-600"}>{limit.queued > 0 ? `排队中 ${limit.queued}` : "运行中"} · {limit.active}/{limit.limit}</p>}
                  {limit?.queue?.length > 0 && <div className="mt-2 space-y-1 text-xs text-amber-700">
                    {limit.queue.map((queued) => <p key={`${queued.requestId}-${queued.position}`}>请求 {queued.requestId ? `#${queued.requestId.slice(0, 8)}` : "#未知"} · 排队中 · 位置 {queued.position} · 已等待 {formatLatency(queued.waitMs)}</p>)}
                  </div>}
                  <p className="mt-1 text-xs text-text-muted">
                    当前延迟：{formatLatency(request.latencyMs)}
                  </p>
                  <details className="mt-2 text-xs text-text-muted">
                    <summary className="cursor-pointer select-none text-primary hover:underline">展开 {request.count} 个请求</summary>
                    <div className="mt-2 space-y-2 rounded-lg bg-bg/70 p-3">
                      {(request.requests || []).map((item, index) => (
                        <div key={item.id} className="rounded-md border border-border-subtle bg-surface p-3">
                          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                            <span className="font-medium text-text-main">请求 #{index + 1}</span>
                            <span className="rounded-full bg-primary/10 px-2 py-0.5 font-semibold tabular-nums text-primary">延迟 {formatLatency(item.latencyMs)}</span>
                          </div>
                          <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                            <div><dt className="inline">客户端 IP：</dt><dd className="inline text-text-main">{item.clientIp || "—"}</dd></div>
                            <div><dt className="inline">API Key：</dt><dd className="inline text-text-main">{item.apiKeyName || "未使用 API Key"}{item.apiKeyMasked ? `（${item.apiKeyMasked}）` : ""}</dd></div>
                            <div><dt className="inline">开始时间：</dt><dd className="inline text-text-main">{item.startedAt ? new Date(item.startedAt).toLocaleTimeString() : "—"}</dd></div>
                            <div><dt className="inline">请求延迟：</dt><dd className="inline font-semibold tabular-nums text-text-main">{formatLatency(item.latencyMs)}</dd></div>
                            <div><dt className="inline">状态：</dt><dd className="inline text-text-main">{item.stream ? "流式响应中" : "等待响应"}</dd></div>
                            <div><dt className="inline">请求体：</dt><dd className="inline text-text-main">{item.requestBytes != null ? formatBytes(item.requestBytes) : "—"}</dd></div>
                            <div><dt className="inline">请求端点：</dt><dd className="ml-1 break-all font-mono text-text-main">{item.endpoint || "—"}</dd></div>
                            <div><dt className="inline">上游模型：</dt><dd className="ml-1 break-all font-mono text-text-main">{item.upstreamModel || request.model}</dd></div>
                            <div><dt className="inline">模型级别：</dt><dd className="inline font-semibold text-text-main">{item.thinkingLevel || "auto"}</dd></div>
                            <div><dt className="inline">格式：</dt><dd className="inline text-text-main">{item.sourceFormat || "—"} → {item.targetFormat || "—"}</dd></div>
                          </dl>
                        </div>
                      ))}
                    </div>
                  </details>
                </div>
                <span className="shrink-0 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold tabular-nums text-primary">{request.count} 个请求</span>
              </div>
                );
              })()
            ))}
            {queuedLimits.filter((limit) => !activeRequests.some((request) => limit.scope === "account" && `账号: ${request.account}` === limit.label)).map((limit) => (
              <div key={`queued-${limit.scope}-${limit.id}`} className="py-3 first:pt-0 last:pb-0">
                <p className="text-sm font-medium text-text-main">{limit.label}</p>
                <p className="text-xs text-amber-600">排队中 {limit.queued} · {limit.active}/{limit.limit}</p>
                <div className="mt-2 space-y-1 text-xs text-amber-700">
                  {limit.queue.map((queued) => <p key={`${queued.requestId}-${queued.position}`}>请求 {queued.requestId ? `#${queued.requestId.slice(0, 8)}` : "#未知"} · 排队中 · 位置 {queued.position} · 已等待 {formatLatency(queued.waitMs)}</p>)}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
