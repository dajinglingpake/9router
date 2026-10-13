"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Button from "@/shared/components/Button";
import SegmentedControl from "@/shared/components/SegmentedControl";
import DiagnosticsChart from "./DiagnosticsChart";
import DiagnosticsPressure from "./DiagnosticsPressure";
import DiagnosticsAccounts from "./DiagnosticsAccounts";
import DiagnosticsIdentity from "./DiagnosticsIdentity";
import DiagnosticsDetailsModal from "./DiagnosticsDetailsModal";
import { clock, duration, formatNumber, percent, throughput, Icon } from "./format";

const panel = "rounded-2xl border border-border bg-surface shadow-[var(--shadow-soft)]";
const control = "min-h-11 rounded-lg border border-border bg-surface px-3 text-sm text-text-main outline-none focus-visible:ring-2 focus-visible:ring-primary";
const localDate = value => {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
function makeRange(preset, end = Date.now()) {
  const start = preset === "today" ? new Date(end).setHours(0, 0, 0, 0) : end - Number(preset.replace("h", "")) * 3600000;
  return { preset, start, end };
}
function Metric({ label, value, hint, icon, color = "text-text-main", onClick }) {
  return <button type="button" onClick={onClick} className={`${panel} group flex cursor-pointer flex-col items-start p-5 text-left transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary`}>
    <div className="mb-4 flex w-full items-center justify-between text-sm text-text-muted"><span>{label}</span><Icon className={color}>{icon}</Icon></div>
    <span className={`text-3xl font-semibold tracking-tight tabular-nums ${color}`}>{value}</span>
    <span className="mt-2 text-xs leading-5 text-text-muted">{hint}</span>
  </button>;
}

export default function DiagnosticsDashboard({ initialFocus = null, initialModel = "all" }) {
  const [range, setRange] = useState(() => makeRange("6h"));
  const [customOpen, setCustomOpen] = useState(false);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [rangeError, setRangeError] = useState("");
  const [provider, setProvider] = useState("all");
  const [model, setModel] = useState(initialModel);
  const [slowMs, setSlowMs] = useState(60000);
  const [dimension, setDimension] = useState(initialFocus?.dimension === "byApiKey" ? "byAccount" : "byApiKey");
  const [showAllRows, setShowAllRows] = useState(false);
  const [sort, setSort] = useState("overloadCount");
  const [search, setSearch] = useState("");
  const [focus, setFocus] = useState(initialFocus);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [selection, setSelection] = useState(null);
  const [issue, setIssue] = useState("error");
  const [page, setPage] = useState(1);
  const [refreshTick, setRefreshTick] = useState(0);
  const [result, setResult] = useState({ key: "", data: null, error: "" });
  const rankingRef = useRef(null);
  const options = { start: range.start, end: range.end, provider, model, slowMs, issue, page, pageSize: 20,
    focusApiKeyId: focus?.dimension === "byApiKey" ? focus.id : null,
    focusConnectionId: focus?.dimension === "byAccount" ? focus.id : null,
    apiKeyId: selection?.dimension === "byApiKey" ? selection.id : null,
    connectionId: selection?.dimension === "byAccount" ? selection.id : null };
  const requestKey = JSON.stringify({ ...options, refreshTick });

  useEffect(() => {
    const controller = new AbortController();
    const query = JSON.parse(requestKey);
    const load = async () => {
      const params = new URLSearchParams({ start: new Date(query.start).toISOString(), end: new Date(query.end).toISOString(),
        slowMs: String(query.slowMs), provider: query.provider, model: query.model, issue: query.issue, page: String(query.page) });
      if (query.focusApiKeyId) params.set("focusApiKeyId", query.focusApiKeyId);
      if (query.focusConnectionId) params.set("focusConnectionId", query.focusConnectionId);
      if (query.apiKeyId) params.set("apiKeyId", query.apiKeyId);
      if (query.connectionId) params.set("connectionId", query.connectionId);
      const response = await fetch(`/api/usage/diagnostics?${params}`, { cache: "no-store", signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取诊断数据失败");
      return data;
    };
    load().then(data => {
      if (controller.signal.aborted) return;
      setResult({ key: requestKey, data, error: "" });
    })
      .catch(error => { if (!controller.signal.aborted) setResult({ key: requestKey, data: null, error: error.message }); });
    return () => controller.abort();
  }, [requestKey]);

  const data = result.data;
  const error = result.key === requestKey ? result.error : "";
  const loading = result.key !== requestKey;
  const rows = useMemo(() => (data?.[dimension] || []).filter(row => `${row.name} ${row.providers.join(" ")} ${row.related.map(r => r.name).join(" ")}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => (b[sort] ?? -1) - (a[sort] ?? -1) || b.recordCount - a.recordCount), [data, dimension, search, sort]);
  const resetScope = () => { setSelection(null); setPage(1); };
  const changeModel = value => {
    setModel(value); resetScope();
    const url = new URL(window.location.href);
    if (value === "all") url.searchParams.delete("model"); else url.searchParams.set("model", value);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
  };
  const changeRange = nextRange => { setRange(nextRange); resetScope(); setRangeError(""); };
  const focusTime = (start, end) => { changeRange({ preset: "custom", start, end }); setCustomStart(localDate(start)); setCustomEnd(localDate(end)); setCustomOpen(true); };
  const focusGroup = (row, group = dimension) => {
    const next = row ? { id: row.id, dimension: group } : null;
    setFocus(next); resetScope(); setSearch(""); setShowAllRows(false); setDetailsOpen(false);
    if (row) setDimension(group === "byApiKey" ? "byAccount" : "byApiKey");
    const url = new URL(window.location.href);
    url.searchParams.delete("focusApiKeyId"); url.searchParams.delete("focusConnectionId");
    if (next) url.searchParams.set(group === "byApiKey" ? "focusApiKeyId" : "focusConnectionId", next.id);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
  };
  const focusIssue = (value, row = null, group = dimension) => {
    setSelection(row ? { id: row.id, name: row.name, dimension: group } : null);
    setIssue(value); setPage(1); setDetailsOpen(true);
  };
  const applyCustom = event => {
    event.preventDefault();
    const start = new Date(customStart).getTime(), end = new Date(customEnd).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) { setRangeError("结束时间须晚于开始时间。"); return; }
    if (end - start > 31 * 86400000) { setRangeError("单次最多查询 31 天。"); return; }
    changeRange({ preset: "custom", start, end });
  };
  const summary = data?.summary;
  const focusName = focus ? (focus.dimension === "byApiKey" ? data?.subjects.apiKeys : data?.subjects.accounts)?.find(item => item.id === focus.id)?.name || focus.id : null;


  return <div data-i18n-skip className="flex min-w-0 flex-col gap-6 text-text-main">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><div className="mb-2 flex items-center gap-2 text-xs font-medium text-text-muted"><span className="h-1.5 w-1.5 rounded-full bg-info" />实际日志 · 按所选时间段汇总</div>
        <h1 className="text-2xl font-semibold tracking-tight">请求质量总览</h1><p className="mt-2 text-sm text-text-muted">比较稳定账号、响应等待和过载情况，定位受影响的 API Key。</p></div>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" icon="refresh" className="min-h-11" loading={loading} onClick={() => { if (range.preset !== "custom") setRange(makeRange(range.preset)); setRefreshTick(v => v + 1); }}>刷新</Button>
      </div>
    </div>

    <section className={`${panel} p-4`} aria-label="诊断筛选">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1 rounded-lg bg-surface-2 p-1" aria-label="时间范围">
          {[{ value: "1h", label: "最近 1 小时" }, { value: "6h", label: "6 小时" }, { value: "24h", label: "24 小时" }, { value: "today", label: "今天" }].map(item => <button key={item.value} type="button" aria-pressed={range.preset === item.value} onClick={() => { changeRange(makeRange(item.value)); setCustomOpen(false); }} className={`min-h-9 cursor-pointer rounded-md px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${range.preset === item.value ? "bg-surface text-text-main shadow-sm" : "text-text-muted hover:text-text-main"}`}>{item.label}</button>)}
          <button type="button" aria-expanded={customOpen} onClick={() => { setCustomOpen(v => !v); setCustomStart(localDate(range.start)); setCustomEnd(localDate(range.end)); }} className={`flex min-h-9 cursor-pointer items-center gap-1 rounded-md px-3 text-xs font-medium ${range.preset === "custom" ? "bg-surface shadow-sm" : "text-text-muted"}`}><Icon className="text-[16px]">calendar_month</Icon>自定义</button>
        </div>
        <label className="flex items-center gap-2 text-xs text-text-muted">提供商<select className={control} value={provider} onChange={e => { setProvider(e.target.value); resetScope(); }}><option value="all">全部提供商</option>{(data?.providers || []).map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="flex min-w-0 items-center gap-2 text-xs text-text-muted">模型<select aria-label="诊断模型" className={`${control} min-w-0 max-w-56`} value={model} onChange={e => changeModel(e.target.value)}><option value="all">全部模型</option>{[...new Set([...(data?.models || []), ...(model === "all" ? [] : [model])])].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="flex items-center gap-2 text-xs text-text-muted">长响应阈值<select className={control} value={slowMs} onChange={e => { setSlowMs(Number(e.target.value)); setPage(1); }}>{[30000, 60000, 120000].map(value => <option key={value} value={value}>总耗时 ≥ {value / 1000}s</option>)}</select></label>
        <span className="ml-auto text-xs text-text-muted">总耗时包含生成时间；过载依据上游错误内容</span>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border-subtle pt-4">
        <label className="flex min-w-0 flex-1 flex-wrap items-center gap-3 text-sm font-medium">仅关注
          <select aria-label="仅关注某个账号或 API Key" className={`${control} min-w-0 max-w-full flex-1 sm:max-w-sm`} value={focus ? `${focus.dimension}:${focus.id}` : "all"} onChange={event => {
            if (event.target.value === "all") { focusGroup(null); return; }
            const [group, ...id] = event.target.value.split(":"); focusGroup({ id: id.join(":") }, group);
          }}>
            <option value="all">全部账号与 API Key</option>
            <optgroup label="API Key">{(data?.subjects.apiKeys || []).map(item => <option key={item.id} value={`byApiKey:${item.id}`}>{item.name}</option>)}</optgroup>
            <optgroup label="账号">{(data?.subjects.accounts || []).map(item => <option key={item.id} value={`byAccount:${item.id}`}>{item.name}</option>)}</optgroup>
          </select>
        </label>
        <span className="text-xs text-text-muted">关注后，指标、趋势与排行一起筛选</span>
      </div>
      {focus && <div role="status" className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-primary/5 px-3 py-2 text-sm"><Icon className="text-primary">filter_center_focus</Icon><span className="min-w-0 flex-1 break-all">仅关注{focus.dimension === "byApiKey" ? " API Key" : "账号"}：<strong>{focusName}</strong></span><button className="min-h-9 cursor-pointer rounded-md px-2 text-xs text-primary hover:bg-primary/10" onClick={() => focusGroup(null)}>返回全部</button></div>}
      {customOpen && <form onSubmit={applyCustom} className="mt-4 flex flex-wrap items-end gap-3 border-t border-border-subtle pt-4">
        <label className="flex flex-col gap-1.5 text-xs text-text-muted">开始时间<input className={control} type="datetime-local" required value={customStart} onChange={e => setCustomStart(e.target.value)} /></label>
        <label className="flex flex-col gap-1.5 text-xs text-text-muted">结束时间<input className={control} type="datetime-local" required value={customEnd} onChange={e => setCustomEnd(e.target.value)} /></label>
        <Button type="submit" size="lg">应用时间段</Button>{rangeError && <p role="alert" className="text-sm text-danger">{rangeError}</p>}
      </form>}
      {data && <p className="mt-3 text-xs text-text-muted">{new Date(data.range.start).toLocaleString("zh-CN", { hour12: false })} — {new Date(data.range.end).toLocaleString("zh-CN", { hour12: false })}<span className="mx-2 text-border">|</span>{loading ? "正在更新…" : `更新于 ${clock(data.generatedAt)}`}</p>}
    </section>

    {error && <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-danger/25 bg-danger/5 p-4 text-sm text-danger"><span>{error}</span><Button variant="outline" onClick={() => setRefreshTick(v => v + 1)}>重试</Button></div>}
    {data?.truncated && <p role="status" className="rounded-xl border border-warning/30 bg-warning/10 p-3 text-sm text-amber-800 dark:text-amber-200">日志数量已达到本次读取上限，以下为已读取样本的统计。请缩短时间范围以查看完整汇总。</p>}
    {!data && !error && <div role="status" aria-label="正在加载诊断数据" className="grid animate-pulse grid-cols-2 gap-4 motion-reduce:animate-none xl:grid-cols-4">{[0, 1, 2, 3].map(index => <div key={index} className={`${panel} h-40 bg-surface-2`} />)}</div>}
    {summary && <>
      <div className={`grid grid-cols-2 gap-4 xl:grid-cols-4 ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
        <Metric label="请求记录" value={formatNumber(summary.recordCount)} hint={`${formatNumber(summary.successCount)} 次成功完成 · ${summary.cancelledCount} 次取消`} icon="receipt_long" onClick={() => focusIssue("all")} />
        <Metric label="失败尝试" value={formatNumber(summary.failureCount)} hint={`异常占比 ${percent(summary.errorRate)} · ${summary.recoveredCount} 次已重试恢复`} icon="error" color="text-danger" onClick={() => focusIssue("error")} />
        <Metric label="上游报告过载" value={formatNumber(summary.overloadCount)} hint={`${data.pressure.affectedAccounts} 个账号 · ${data.pressure.affectedApiKeys} 个 API Key 遇到过载`} icon="report" color="text-danger" onClick={() => focusIssue("overload")} />
        <Metric label="全程输出吞吐" value={throughput(summary.throughputMeanTps)} hint={`${formatNumber(summary.throughputSamples)} 次有效记录 · 按日志总耗时，含执行内等待`} icon="speed" onClick={() => { setSort("throughputMeanTps"); rankingRef.current?.scrollIntoView({ block: "start" }); }} />
      </div>

      <DiagnosticsAccounts performance={data.accountPerformance} loading={loading} onFocusAccount={focusGroup}
        onShowOverload={row => focusIssue("overload", row, "byAccount")} onShowFailures={row => focusIssue("error", row, "byAccount")} />

      {!summary.recordCount ? <div className={`${panel} flex flex-col items-center px-6 py-14 text-center`}>
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-2 text-text-muted"><Icon className="text-[28px]">query_stats</Icon></div>
        <h2 className="text-lg font-semibold">这段时间还没有请求记录</h2><p className="mt-2 max-w-md text-sm leading-6 text-text-muted">可以扩大查询时间范围，或返回全部账号与 API Key。</p>
        {focus && <Button variant="secondary" className="mt-5 min-h-11" onClick={() => focusGroup(null)}>返回全部</Button>}
      </div> : <>
        <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
          <section className={`${panel} min-w-0 p-5`}><DiagnosticsChart timeline={data.timeline} onFocus={focusTime} /></section>
          <DiagnosticsPressure pressure={data.pressure} onFocusTime={focusTime} onFocusAccount={focusGroup} />
        </div>

        <section ref={rankingRef} className={`${panel} scroll-mt-6 overflow-hidden`} aria-label="API Key 与账号排行">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border-subtle p-5">
            <div><h2 className="text-base font-semibold">异常与延迟排行</h2><p className="mt-1 text-xs text-text-muted">名称可选中复制，使用“仅关注”按钮筛选；点击失败、过载或长响应次数查看明细</p></div>
            <SegmentedControl options={[{ value: "byApiKey", label: "按 API Key", icon: "key" }, { value: "byAccount", label: "按账号", icon: "account_circle" }]} value={dimension} onChange={setDimension} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
            <button className="min-h-11 cursor-pointer text-xs text-primary hover:underline" onClick={() => focusIssue("slow")}>查看长响应 {formatNumber(summary.slowCount)} 条</button>
            <label className="relative"><span className="sr-only">搜索 API Key 或账号</span><Icon className="pointer-events-none absolute left-3 top-3 text-text-muted">search</Icon><input value={search} onChange={e => setSearch(e.target.value)} className={`${control} w-full pl-10 sm:w-72`} placeholder={dimension === "byApiKey" ? "搜索 Key 名称或关联账号" : "搜索账号或调用人"} /></label>
            <label className="flex items-center gap-2 text-xs text-text-muted">排序<select className={control} value={sort} onChange={e => setSort(e.target.value)}>{[{ value: "throughputMeanTps", label: "全程吞吐最高" }, { value: "overloadCount", label: "过载报告优先" }, { value: "failureCount", label: "失败次数优先" }, { value: "errorRate", label: "异常占比优先" }, { value: "slowCount", label: "长响应次数优先" }, { value: "ttftP95Ms", label: "开始响应 P95 优先" }, { value: "p95Ms", label: "总耗时 P95 优先" }, { value: "recordCount", label: "请求数优先" }].map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-sm"><caption className="sr-only">{dimension === "byApiKey" ? "API Key" : "账号"}的失败与延迟排行</caption>
              <thead className="bg-surface-2/60 text-xs text-text-muted"><tr>{[dimension === "byApiKey" ? "API Key / 关联账号" : "账号 / 调用人", "请求记录", "失败 / 异常占比", "上游过载", "长响应", "开始响应 P95", "全程吞吐 / 总耗时 P95", "主要问题"].map(label => <th key={label} className="whitespace-nowrap px-4 py-3 font-medium first:pl-5">{label}</th>)}</tr></thead>
              <tbody>{(showAllRows ? rows : rows.slice(0, 8)).map((row, index) => <tr key={row.id} className={`border-t border-border-subtle transition-colors hover:bg-surface-2/50 ${focus?.dimension === dimension && focus.id === row.id ? "bg-primary/5" : ""}`}>
                <td className="max-w-72 py-4 pl-5 pr-4"><div className="flex items-start gap-3"><span className={`mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs font-medium tabular-nums ${index < 3 && (row.failureCount || row.slowCount) ? "bg-primary/10 text-primary" : "bg-surface-2 text-text-muted"}`}>{index + 1}</span><div className="min-w-0">
                  <DiagnosticsIdentity name={row.name} label={dimension === "byAccount" ? "账号" : "API Key 名称"} onFocus={() => focusGroup(row)} />
                  <p className="mt-1 truncate text-xs text-text-muted" title={row.related.map(r => r.name).join("、")}>{row.related.length} 个{dimension === "byApiKey" ? "账号" : "API Key"} · {row.providers.join(" / ")}</p>
                  {row.bindings.length > 0 && <p className="mt-1.5 max-w-64 truncate text-xs text-primary" title={row.bindings.join("、")}>专用：{row.bindings.join("、")}</p>}
                </div></div></td>
                <td className="px-4 py-4 font-mono tabular-nums">{formatNumber(row.recordCount)}</td>
                <td className="px-4 py-4"><span className={`font-mono font-medium tabular-nums ${row.failureCount ? "text-danger" : "text-text-muted"}`}><button className="min-h-8 cursor-pointer underline decoration-dotted underline-offset-4" aria-label={`查看 ${row.name} 的失败尝试`} onClick={() => focusIssue("error", row)}>{row.failureCount}</button></span><span className="mx-1.5 text-text-muted">/</span><span className="text-xs tabular-nums text-text-muted">{percent(row.errorRate)}</span><div className="mt-2 h-1 w-20 overflow-hidden rounded bg-surface-2"><div className="h-full rounded bg-danger/75" style={{ width: `${row.errorRate || 0}%` }} /></div></td>
                <td className="px-4 py-4 font-mono font-medium tabular-nums text-danger"><button className="min-h-8 cursor-pointer underline decoration-dotted underline-offset-4" aria-label={`查看 ${row.name} 的过载报告`} onClick={() => focusIssue("overload", row)}>{row.overloadCount}</button></td>
                <td className={`px-4 py-4 font-mono tabular-nums ${row.slowCount ? "text-amber-700 dark:text-amber-300" : "text-text-muted"}`}><button className="min-h-8 cursor-pointer underline decoration-dotted underline-offset-4" aria-label={`查看 ${row.name} 的长响应`} onClick={() => focusIssue("slow", row)}>{row.slowCount}</button></td>
                <td className="px-4 py-4 font-mono tabular-nums" title={`${row.ttftSamples} 个开始响应样本`}>{duration(row.ttftP95Ms)}</td>
                <td className="px-4 py-4 font-mono tabular-nums" title={`${row.throughputSamples} 个吞吐样本；${row.latencySamples} 个耗时样本`}>{throughput(row.throughputMeanTps)}<p className="mt-1 text-xs text-text-muted">总耗时 {duration(row.p95Ms)}</p></td>
                <td className="max-w-48 px-4 py-4 text-xs text-text-muted">{row.causes[0] ? <><span className="mr-1.5 rounded bg-danger/10 px-1.5 py-0.5 font-mono text-danger">{row.causes[0].statusCode || "错误"}</span><span className="leading-6">{row.causes[0].message}</span></> : row.slowCount ? "响应耗时偏高" : "未发现异常"}</td>
              </tr>)}</tbody>
            </table>
            {!rows.length && <p className="p-8 text-center text-sm text-text-muted">没有匹配的 API Key 或账号</p>}
          </div>
          {rows.length > 8 && <button className="w-full min-h-11 cursor-pointer border-t border-border-subtle text-xs text-primary hover:bg-primary/5" onClick={() => setShowAllRows(value => !value)}>{showAllRows ? "收起排行" : `显示全部 ${rows.length} 个${dimension === "byApiKey" ? " API Key" : "账号"}`}</button>}
        </section>

      </>}
      <details className="rounded-xl border border-dashed border-border px-4 py-3 text-xs leading-6 text-text-muted">
        <summary className="w-fit cursor-pointer font-medium">统计说明与数据完整性 <span className="ml-2 font-normal">已记录耗时 {formatNumber(summary.latencySamples)} / {formatNumber(summary.recordCount)} 条</span></summary>
        <div className="mt-2 grid gap-2 border-t border-border-subtle pt-3 md:grid-cols-2">
          <p>成功完成来自用量日志；失败来自错误日志，按失败尝试去重。同一次调用可能产生多次失败尝试，已重试恢复仍会保留，因此“异常占比”不等于调用最终失败率。客户端取消单独统计。</p>
          <p>开始响应等待取自代理处理响应流的计时；Codex 包含预读和模型思考，不代表纯网络延迟。与总耗时相等、无法区分完整响应的旧开始响应数据不参与统计。总耗时包含响应生成。P95 表示 95% 的已记录样本不超过该值。缺失耗时显示为“—”，不按 0 计入统计。较长的输出也可能产生较高总耗时。</p>
          <p>过载仅统计上游明确报告过载或并发限制的错误，普通 503、配额不足和本地路由不可用分别处理。等待异常按 15 分钟窗口对照此前 7 天同账号、同模型的成功开始响应数据；历史至少 20 条、窗口至少 5 条，窗口中位数至少 10 秒且超过历史 P95 才提示。</p>
          <p>排队 P95 仅来自记录了排队耗时的失败日志，不代表所有请求的排队情况。历史不足、日志缺失时不能据此认定没有过载，也不能认定调用人造成了过载。</p>
          <p className="md:col-span-2">统计仅涵盖仍保留的日志；已清空的错误日志与部分未记录用量的成功响应无法追溯。时间段按日志发生时间归属，当前执行中的请求请在“运行状态”查看。</p>
        </div>
      </details>
    </>}
    <DiagnosticsDetailsModal isOpen={detailsOpen} onClose={() => setDetailsOpen(false)} data={loading ? null : data} loading={loading} error={error} selection={selection} focusName={focusName} issue={issue} onIssueChange={value => { setIssue(value); setPage(1); }} onPageChange={setPage} slowMs={slowMs} />
  </div>;
}
