"use client";

import { useEffect, useMemo, useState } from "react";
import Card from "@/shared/components/Card";
import Modal from "@/shared/components/Modal";
import { groupActiveRequests } from "@/lib/activeRequestGroups";

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
          <p data-i18n-skip className={`mt-2 text-2xl font-semibold tabular-nums ${tone}`}>{value}</p>
          <p data-i18n-skip className="mt-1 text-xs text-text-muted">{detail}</p>
        </div>
        <span className="material-symbols-outlined rounded-lg bg-bg p-2 text-xl text-text-muted" aria-hidden="true">{icon}</span>
      </div>
    </Card>
  );
}

function queueStatus(item) {
  const retry = item?.retryCount > 0 ? `第 ${item.retryCount} 次重试` : "";
  if (item?.state === "cooldown") return retry ? `${retry}，剩余 ${Math.ceil(item.cooldownRemainingMs / 1000)} 秒` : `${Math.ceil(item.cooldownRemainingMs / 1000)} 秒后尝试`;
  if (retry) return `${retry}，排队中`;
  if (item?.state === "recovering") return "排队等待";
  return "排队等待";
}

function RequestDetails({ item, index, waiting = false, failed = false }) {
  const status = failed ? (item.recovered ? "已重试成功" : "请求失败") : waiting ? queueStatus(item) : item.retryCount > 0 ? `第 ${item.retryCount} 次重试` : "请求执行中";
  const startedAt = waiting ? item.queuedAt || item.startedAt : item.startedAt || item.queuedAt;
  const statusColor = failed ? (item.recovered ? "text-emerald-600" : "text-red-600") : waiting ? "text-amber-700" : "text-primary";
  const attachmentTokens = item.estimatedAttachmentTokens == null ? "未记录"
    : item.unestimatedAttachmentCount > 0
      ? `${item.estimatedAttachmentTokens > 0 ? `${item.estimatedAttachmentTokens.toLocaleString()} + ` : ""}无法估算（${item.unestimatedAttachmentCount} 个附件）`
      : `${item.estimatedAttachmentTokens.toLocaleString()}${item.attachmentCount ? `（${item.attachmentCount} 个附件）` : ""}`;
  return (
    <div data-i18n-skip className={`rounded-md border p-3 ${waiting ? "border-amber-200 bg-amber-50/60" : "border-border-subtle bg-surface"}`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-text-main">请求 #{index + 1}</span>
        <span className={`rounded-full px-2 py-0.5 font-semibold tabular-nums ${statusColor} ${waiting ? "bg-amber-500/15" : "bg-primary/10"}`}>{status}</span>
      </div>
      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        <div><dt className="inline">状态：</dt><dd className={`inline font-semibold ${statusColor}`}>{status}</dd></div>
        <div><dt className="inline">队列位置：</dt><dd className="inline text-text-main">{item.position || "—"}</dd></div>
        <div><dt className="inline">{waiting ? "已等待：" : "请求延迟："}</dt><dd className="inline text-text-main">{failed && (waiting ? item.waitMs : item.latencyMs) == null ? "未记录" : formatLatency(waiting ? item.waitMs : item.latencyMs)}</dd></div>
        <div><dt className="inline">距离超时：</dt><dd className="inline text-text-main">{item.timeoutRemainingMs == null ? "—" : formatLatency(item.timeoutRemainingMs)}</dd></div>
        <div><dt className="inline">客户端 IP：</dt><dd className="inline text-text-main">{item.clientIp || "—"}</dd></div>
        <div><dt className="inline">API Key：</dt><dd className="inline text-text-main">{item.apiKeyName || (failed ? "未记录" : "未使用 API Key")}{item.apiKeyMasked ? `（${item.apiKeyMasked}）` : ""}</dd></div>
        <div><dt className="inline">开始时间：</dt><dd className="inline text-text-main">{startedAt ? new Date(startedAt).toLocaleTimeString() : "—"}</dd></div>
        <div><dt className="inline">客户端模型：</dt><dd className="inline break-all font-mono text-text-main">{item.requestedModel || "—"}</dd></div>
        <div><dt className="inline">上游模型：</dt><dd className="inline break-all font-mono text-text-main">{item.upstreamModel || "—"}</dd></div>
        <div><dt className="inline">请求体：</dt><dd className="inline text-text-main">{item.requestBytes != null ? formatBytes(item.requestBytes) : "—"}</dd></div>
        <div title="粗略估算消息文本、系统提示词和工具定义。旧日志保留原来的请求体长度预估。"><dt className="inline">{item.inputTokenEstimateVersion ? "文本 Token（预估）：" : "输入 Token（旧预估）："}</dt><dd className="inline text-text-main">{item.estimatedInputTokens?.toLocaleString() ?? "未记录"}</dd></div>
        <div title="文本文件单独估算；图片、PDF、音频等不能按编码长度换算，无法估算的附件单独列出。"><dt className="inline">附件 Token（预估）：</dt><dd className="inline text-text-main">{attachmentTokens}</dd></div>
        {item.encryptedContextCount > 0 && <div><dt className="inline">加密上下文：</dt><dd className="inline text-text-main">{item.encryptedContextCount} 段，Token 无法估算</dd></div>}
        <div><dt className="inline">上游 Token：</dt><dd className="inline text-text-main">输入 {item.inputTokens?.toLocaleString() ?? "未返回"} · 输出 {item.outputTokens?.toLocaleString() ?? "未返回"}</dd></div>
        {failed && item.recovered && <div className="sm:col-span-2"><dt className="inline">重试成功用量：</dt><dd className="inline text-text-main">输入 {item.recoveredUsage?.inputTokens?.toLocaleString() ?? "未返回"} · 输出 {item.recoveredUsage?.outputTokens?.toLocaleString() ?? "未返回"} Token</dd></div>}
        <div><dt className="inline">请求端点：</dt><dd className="inline break-all font-mono text-text-main">{item.endpoint || "—"}</dd></div>
        <div><dt className="inline">模型级别：</dt><dd className="inline font-semibold text-text-main">{item.thinkingLevel || (failed ? "未记录" : "auto")}</dd></div>
        <div><dt className="inline">格式：</dt><dd className="inline text-text-main">{item.sourceFormat || "—"} → {item.targetFormat || "—"}</dd></div>
        <div><dt className="inline">响应模式：</dt><dd className="inline text-text-main">{item.stream == null ? "—" : item.stream ? "流式" : "JSON"}</dd></div>
        <div><dt className="inline">请求 ID：</dt><dd className="inline font-mono text-text-main">{item.requestId ? `#${item.requestId.slice(0, 8)}` : "—"}</dd></div>
        <div><dt className="inline">重试次数：</dt><dd className="inline text-text-main">{item.retryCount || 0}</dd></div>
        {failed && <div><dt className="inline">错误时状态：</dt><dd className="inline text-text-main">{({ running: "执行中", queued: "排队中", cooldown: "冷却等待", recovering: "等待重试" })[item.state] || "未记录"}</dd></div>}
        {!waiting && item.waitMs != null && <div><dt className="inline">排队耗时：</dt><dd className="inline text-text-main">{formatLatency(item.waitMs)}</dd></div>}
        {item.cooldownRemainingMs != null && <div><dt className="inline">冷却剩余：</dt><dd className="inline text-text-main">{formatLatency(item.cooldownRemainingMs)}</dd></div>}
        <div className="break-all sm:col-span-2"><dt className="inline">客户端：</dt><dd className="inline text-text-main">{item.userAgent || "未记录"}</dd></div>
      </dl>
    </div>
  );
}

function QueuedRequestDetails({ queue = [], startIndex = 0 }) {
  return queue.map((item, index) => <RequestDetails key={item.requestId || item.position} item={item} index={startIndex + index} waiting />);
}

export default function SystemMetrics() {
  const [metrics, setMetrics] = useState(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [errorDetails, setErrorDetails] = useState(null);

  const showErrors = (request = null) => {
    setErrorDetails({
      filter: request ? { connectionId: request.connectionId, provider: request.provider, model: request.model } : {},
      items: [], total: 0, loading: true,
    });
  };
  const filteredErrors = errorDetails?.items || [];
  const errorFilter = errorDetails?.filter;

  useEffect(() => {
    if (!errorFilter) return;
    const controller = new AbortController();
    setErrorDetails(current => current?.filter === errorFilter ? { ...current, loading: true, error: "" } : current);
    fetch(`/api/system/errors?${new URLSearchParams(errorFilter)}`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("读取错误日志失败");
        const result = await response.json();
        if (!controller.signal.aborted) setErrorDetails(current => current?.filter === errorFilter ? { ...current, ...result, loading: false } : current);
      })
      .catch(error => {
        if (!controller.signal.aborted) setErrorDetails(current => current?.filter === errorFilter ? { ...current, loading: false, error: error.message } : current);
      });
    return () => controller.abort();
  }, [errorFilter]);

  const loadMoreErrors = async () => {
    const current = errorDetails;
    setErrorDetails(value => ({ ...value, loading: true, error: "" }));
    try {
      const response = await fetch(`/api/system/errors?${new URLSearchParams({ ...current.filter, beforeId: current.nextBeforeId })}`, { cache: "no-store" });
      if (!response.ok) throw new Error("读取错误日志失败");
      const result = await response.json();
      setErrorDetails(value => value?.filter === current.filter ? { ...value, items: [...value.items, ...result.items], nextBeforeId: result.nextBeforeId, loading: false } : value);
    } catch (error) {
      setErrorDetails(value => value?.filter === current.filter ? { ...value, loading: false, error: error.message } : value);
    }
  };

  const clearErrors = async () => {
    const current = errorDetails;
    if (!window.confirm(`清空当前筛选范围内的 ${current.total} 条错误日志？此操作不可撤销。`)) return;
    setErrorDetails(value => ({ ...value, clearing: true, error: "" }));
    try {
      const response = await fetch("/api/system/errors", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...current.filter, beforeId: current.beforeId, confirmed: true }),
      });
      if (!response.ok) throw new Error(response.status === 401 ? "请先登录后清空日志" : "清空错误日志失败");
      setErrorDetails(value => value?.filter === current.filter ? { ...value, filter: { ...value.filter }, clearing: false } : value);
      setRefreshTick(value => value + 1);
    } catch (error) {
      setErrorDetails(value => value?.filter === current.filter ? { ...value, clearing: false, error: error.message } : value);
    }
  };

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const controller = new AbortController();
    let retryTimer = null;
    let quickRetryDone = false;
    const load = async () => {
      if (!active || inFlight) return;
      inFlight = true;
      if (active) setRefreshing(true);
      try {
        const response = await fetch("/api/system/metrics", { cache: "no-store", signal: controller.signal });
        if (!active) return;
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
        inFlight = false;
        if (active) setRefreshing(false);
      }
    };
    load();
    const timer = autoRefresh ? setInterval(load, 3000) : null;
    return () => { active = false; controller.abort(); if (timer) clearInterval(timer); if (retryTimer) clearTimeout(retryTimer); };
  }, [refreshTick, autoRefresh]);

  const memoryPercent = useMemo(() => {
    if (!metrics?.memory?.systemTotal) return 0;
    return Math.round((1 - metrics.memory.systemFree / metrics.memory.systemTotal) * 100);
  }, [metrics]);

  const processMemory = metrics?.memory?.rss || 0;
  const processMemoryPercent = metrics?.memory?.systemTotal
    ? Math.round((processMemory / metrics.memory.systemTotal) * 1000) / 10
    : 0;
  const concurrencyLimits = metrics?.concurrencyLimits || [];
  const activeRequests = groupActiveRequests(metrics?.activeRequests || [], concurrencyLimits, metrics?.modelRequestStats || []);
  const queuedLimits = concurrencyLimits.filter((item) => item.scope !== "account" && item.queued > 0);
  const runningLimits = concurrencyLimits.filter((item) => item.active > 0);
  const representedLimitKeys = new Set(activeRequests.flatMap((request) => {
    const limit = request.limit;
    return limit ? [`${limit.scope}:${limit.id}`] : [];
  }));

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
          <MetricCard icon="check_circle" label="请求成功率" value={metrics ? <button type="button" onClick={() => showErrors()} className="cursor-pointer underline decoration-dotted underline-offset-4" aria-label="查看请求错误详情">{metrics.requestStats.successRatePercent}%</button> : "—"} detail={metrics ? `错误 ${metrics.requestStats.errorCount ?? metrics.requestStats.clientErrors + metrics.requestStats.serverErrors}` : "正在读取"} tone="text-emerald-600" />
          <MetricCard icon="speed" label="实时输出速度" value={`${metrics?.traffic?.outputTokensPerSecond || 0} tokens/s`} detail="最近 10 秒流式输出估算" tone="text-amber-600" />
          <MetricCard icon="wifi" label="网络连接数" value={metrics?.networkConnections ?? "—"} detail="当前活动 Socket 连接" tone="text-cyan-600" />
        </div>
      </section>

      <Modal isOpen={errorDetails !== null} onClose={() => setErrorDetails(null)} title="请求异常详情" size="full">
        <p className="mb-4 text-sm text-text-muted">日志已持久保存，重启后保留。包含重试过程中的错误，清空只影响当前筛选范围内的日志。</p>
        <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
          <label htmlFor="request-error-category" className="text-text-muted">筛选类型</label>
          <select id="request-error-category" value={errorDetails?.filter?.category || ""} disabled={errorDetails?.clearing || errorDetails?.loading} onChange={(event) => setErrorDetails((current) => ({ ...current, filter: { ...current.filter, category: event.target.value }, items: [] }))} className="rounded-lg border border-border-subtle bg-surface px-3 py-2 text-text-main">
            <option value="">全部</option>
            <option value="client">客户端错误</option>
            <option value="server">服务端错误</option>
            <option value="cancelled">请求取消</option>
          </select>
          <span className="text-text-muted">已显示 {filteredErrors.length} / {errorDetails?.total || 0} 条</span>
          <button type="button" onClick={clearErrors} disabled={errorDetails?.loading || errorDetails?.clearing || !errorDetails?.total} className="ml-auto rounded-lg border border-border-subtle px-3 py-2 text-red-600 disabled:opacity-50">{errorDetails?.clearing ? "正在清空…" : "清空日志"}</button>
        </div>
        {errorDetails?.error && <p role="alert" className="mb-3 text-sm text-red-600">{errorDetails.error}</p>}
        {filteredErrors.length ? (
          <div className="space-y-3">
            {filteredErrors.map((item, index) => (
              <details key={item.id || index} className="rounded-lg border border-border-subtle p-3">
                <summary className="cursor-pointer break-words text-sm text-text-main">
                  <span className={`mr-2 font-semibold ${item.category === "cancelled" ? "text-text-muted" : "text-red-600"}`}>{item.summary}</span>
                  {item.provider || "—"} / {item.model || "—"}
                  <span className="ml-2 text-text-muted">{new Date(item.timestamp).toLocaleString()}</span>
                  {item.transient && <span className={`ml-2 font-medium ${item.recovered ? "text-emerald-600" : "text-amber-600"}`}>{item.recovered ? "已重试成功" : "尚未重试成功"}</span>}
                  <span className="mt-1 block break-words text-xs text-text-muted" data-i18n-skip>调用方：{item.apiKeyName || "未记录"} · IP：{item.clientIp && item.clientIp !== "unknown" ? item.clientIp : "未记录"}</span>
                </summary>
                <p className="mt-3 text-xs text-text-muted">上游账号：{item.account} · 状态码：{item.statusCode || item.status}</p>
                <div className="mt-2 text-xs text-text-muted"><RequestDetails item={item} index={index} waiting={["queued", "cooldown", "recovering"].includes(item.state)} failed /></div>
                {item.transient && <p className="mt-1 text-xs text-text-muted">上游 HTTP：{item.upstreamStatus || "—"} · 排队重试 {item.retryCount} 次 · 流式尝试第 {item.sseAttempt} 次 · HTTP 尝试第 {item.attempt} 次</p>}
                {item.requestId && <p className="mt-1 break-all text-xs text-text-muted">请求 ID：{item.requestId}</p>}
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-bg p-3 text-xs text-text-main">{item.message || "该记录未保存错误原因，详情请查看对应时间的服务端容器日志。"}</pre>
                {item.headers && Object.keys(item.headers).length > 0 && <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words rounded-md bg-bg p-3 text-xs text-text-muted">{JSON.stringify(item.headers, null, 2)}</pre>}
              </details>
            ))}
          </div>
        ) : !errorDetails?.loading && !errorDetails?.error && <p className="py-6 text-center text-sm text-text-muted">当前筛选范围内没有错误日志。</p>}
        {errorDetails?.loading && <p className="py-3 text-center text-sm text-text-muted">正在读取日志…</p>}
        {errorDetails?.nextBeforeId != null && <button type="button" onClick={loadMoreErrors} disabled={errorDetails.loading || errorDetails.clearing} className="mt-4 w-full rounded-lg border border-border-subtle py-2 text-sm text-primary disabled:opacity-50">加载更多</button>}
      </Modal>

      <Card title="活跃请求" subtitle="按模型与提供商聚合的当前请求">
        {activeRequests.length === 0 && queuedLimits.length === 0 && runningLimits.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border-subtle px-4 py-10 text-center text-sm text-text-muted">当前没有进行中的请求</div>
        ) : (
          <div className="divide-y divide-border-subtle">
            {activeRequests.map((request) => (
              (() => {
                const limit = request.limit;
                return (
              <div key={`${request.model}-${request.provider}-${request.connectionId || request.account}`} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text-main">{request.model}</p>
                  <p className="text-xs text-text-muted">{request.provider} · {request.account}</p>
                  {limit && <p className="mt-1 text-xs text-text-muted">并发 {limit.active}/{limit.limit}</p>}
                  <p className="mt-1 text-xs text-text-muted">
                    {request.count ? `当前延迟：${formatLatency(request.latencyMs)}` : "排队中"}
                  </p>
                  <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-muted" title="本次服务启动后累计；同一请求的多次过载只计一次，响应成功完成后计入重试后成功。">
                    <span>累计请求 <span className="font-semibold tabular-nums text-text-main">{request.stats?.requests ?? 0}</span></span>
                    <button type="button" onClick={() => showErrors(request)} className="cursor-pointer underline decoration-dotted underline-offset-4" aria-label={`查看 ${request.account} ${request.model} 的错误日志`}>曾遇到过载 <span className="font-semibold tabular-nums text-amber-600">{request.stats?.overloaded ?? 0}</span></button>
                    <span>重试后成功 <span className="font-semibold tabular-nums text-emerald-600">{request.stats?.recovered ?? 0}</span></span>
                  </p>
                  <details className="mt-2 text-xs text-text-muted">
                    <summary className="cursor-pointer select-none text-primary hover:underline">展开 {request.count + request.queue.length} 个请求</summary>
                    <div className="mt-2 space-y-2 rounded-lg bg-bg/70 p-3">
                      {(request.requests || []).map((item, index) => (
                        <RequestDetails key={item.id} item={{ ...item, upstreamModel: item.upstreamModel || request.model }} index={index} />
                      ))}
                      <QueuedRequestDetails queue={request.queue} startIndex={request.count} />
                    </div>
                  </details>
                </div>
                <span className="shrink-0 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold tabular-nums text-primary">{request.count + request.queue.length} 个请求</span>
              </div>
                );
              })()
            ))}
            {runningLimits.filter((limit) => !representedLimitKeys.has(`${limit.scope}:${limit.id}`)).map((limit) => (
              <div key={`running-${limit.scope}-${limit.id}`} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text-main">{limit.label}</p>
                  <p className="text-xs text-text-muted">{limit.scope === "account" ? "账号并发槽位" : "API Key 并发槽位"} · 并发 {limit.active}/{limit.limit}</p>
                </div>
                <span className="shrink-0 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold tabular-nums text-primary">{limit.active} 个请求</span>
              </div>
            ))}
            {queuedLimits.filter((limit) => !activeRequests.some((request) => limit.scope === "account" && `账号: ${request.account}` === limit.label)).map((limit) => (
              <div key={`queued-${limit.scope}-${limit.id}`} className="py-3 first:pt-0 last:pb-0">
                <p className="text-sm font-medium text-text-main">{limit.label}</p>
                <p className="text-xs text-text-muted">并发 {limit.active}/{limit.limit}</p>
                <details className="mt-2 text-xs text-text-muted">
                  <summary className="cursor-pointer select-none text-primary hover:underline">展开 {limit.queue.length} 个请求</summary>
                  <div className="mt-2 space-y-2 rounded-lg bg-bg/70 p-3">
                    <QueuedRequestDetails queue={limit.queue} />
                  </div>
                </details>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
