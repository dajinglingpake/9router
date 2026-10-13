"use client";

import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const time = value => new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

function ChartTooltip({ active, payload }) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return <div className="rounded-xl border border-border bg-surface p-3 text-xs shadow-lg">
    <p className="mb-2 font-semibold text-text-main">{time(point.start)}–{time(point.end)}</p>
    <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-text-muted">
      <span>请求记录</span><span className="text-right font-mono text-text-main">{point.recordCount}</span>
      <span>成功完成</span><span className="text-right font-mono text-text-main">{point.successCount}</span>
      <span>失败尝试</span><span className="text-right font-mono text-danger">{point.failureCount}</span>
      <span>上游过载</span><span className="text-right font-mono text-danger">{point.overloadCount}</span>
      <span>长响应</span><span className="text-right font-mono text-warning">{point.slowCount}</span>
      <span>开始响应等待 P95</span><span className="text-right font-mono text-text-main">{point.latencySeconds == null ? "未记录" : `${point.latencySeconds.toFixed(1)}s`}</span>
    </div>
  </div>;
}

export default function DiagnosticsChart({ timeline, onFocus }) {
  const points = timeline.map(point => ({ ...point, label: time(point.start), latencySeconds: point.ttftP95Ms == null ? null : point.ttftP95Ms / 1000 }));
  return <>
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-base font-semibold text-text-main">请求与延迟趋势</h2><p className="mt-1 text-xs text-text-muted">点击柱形，聚焦对应时段</p></div>
      <div className="flex flex-wrap gap-4 text-xs text-text-muted">
        <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-info/35" />成功完成</span>
        <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-danger" />失败尝试</span>
        <span className="flex items-center gap-1.5"><i className="h-0.5 w-3 bg-primary" />开始响应等待 P95</span>
      </div>
    </div>
    <div className="h-56 min-w-0" role="img" aria-label="各时段成功记录、失败尝试和开始响应等待 P95 趋势；下方可展开数据表">
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0} initialDimension={{ width: 600, height: 224 }}>
        <ComposedChart data={points} margin={{ top: 8, right: 2, left: -22, bottom: 0 }} accessibilityLayer>
          <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 4" />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--color-text-muted)" }} axisLine={false} tickLine={false} minTickGap={24} />
          <YAxis yAxisId="count" tick={{ fontSize: 11, fill: "var(--color-text-muted)" }} axisLine={false} tickLine={false} allowDecimals={false} />
          <YAxis yAxisId="latency" orientation="right" tick={{ fontSize: 11, fill: "var(--color-text-muted)" }} axisLine={false} tickLine={false} unit="s" width={48} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--color-surface-2)" }} />
          <Bar yAxisId="count" dataKey="successCount" stackId="requests" fill="var(--color-info)" fillOpacity={0.3} maxBarSize={30} isAnimationActive={false} onClick={point => onFocus(point.start, point.end)} className="cursor-pointer" />
          <Bar yAxisId="count" dataKey="failureCount" stackId="requests" fill="var(--color-danger)" radius={[3, 3, 0, 0]} maxBarSize={30} isAnimationActive={false} onClick={point => onFocus(point.start, point.end)} className="cursor-pointer" />
          <Line yAxisId="latency" dataKey="latencySeconds" stroke="var(--color-primary)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
    <details className="mt-3 text-xs text-text-muted">
      <summary className="w-fit cursor-pointer py-2 hover:text-text-main">查看时段数据</summary>
      <div className="mt-2 max-h-48 overflow-auto rounded-lg border border-border">
        <table className="w-full text-left"><caption className="sr-only">请求趋势的具体数值，点击时间聚焦对应时段</caption>
          <thead className="sticky top-0 bg-surface-2"><tr>{["时段", "记录", "成功", "失败", "取消", "长响应", "P95"].map(label => <th key={label} className="px-3 py-2 font-medium">{label}</th>)}</tr></thead>
          <tbody>{points.map(point => <tr key={point.start} className="border-t border-border-subtle">
            <td className="px-3 py-1"><button onClick={() => onFocus(point.start, point.end)} className="min-h-9 cursor-pointer text-primary underline-offset-4 hover:underline">{time(point.start)}–{time(point.end)}</button></td>
            <td className="px-3 tabular-nums">{point.recordCount}</td><td className="px-3 tabular-nums">{point.successCount}</td><td className="px-3 tabular-nums">{point.failureCount}</td><td className="px-3 tabular-nums">{point.cancelledCount}</td><td className="px-3 tabular-nums">{point.slowCount}</td><td className="px-3 tabular-nums">{point.latencySeconds == null ? "—" : `${point.latencySeconds.toFixed(1)}s`}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </details>
  </>;
}
