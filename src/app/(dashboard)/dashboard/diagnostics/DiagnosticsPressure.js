"use client";

import { duration, Icon } from "./format";
import DiagnosticsIdentity from "./DiagnosticsIdentity";

const time = value => new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

export default function DiagnosticsPressure({ pressure, onFocusTime, onFocusAccount }) {
  const seen = new Set();
  const windows = (pressure?.windows || []).filter(w => {
    if (seen.has(w.connectionId)) return false;
    seen.add(w.connectionId); return true;
  }).slice(0, 3);
  return <section className="flex flex-col rounded-2xl border border-border bg-surface p-5 shadow-[var(--shadow-soft)]" aria-label="过载与等待分析">
    <h2 className="flex items-center gap-2 text-base font-semibold"><Icon className="text-primary">fact_check</Icon>过载与等待分析</h2>
    <p className="mt-1 text-xs leading-5 text-text-muted">按 15 分钟窗口，区分明确错误与等待异常</p>
    <div className="mt-4 flex flex-1 flex-col gap-3">
      {windows.length ? windows.map(w => <div key={`${w.connectionId}:${w.start}`} className={`rounded-xl border p-3 ${w.overloadCount ? "border-danger/20 bg-danger/5" : "border-warning/25 bg-warning/5"}`}>
        <div className="flex items-center justify-between gap-2 text-xs"><span className={w.overloadCount ? "font-medium text-danger" : "font-medium text-amber-700 dark:text-amber-300"}>{w.overloadCount ? `上游报告过载 ${w.overloadCount} 次` : w.queueTimeoutCount ? `本地排队超时 ${w.queueTimeoutCount} 次` : "开始响应等待异常升高"}</span><button onClick={() => onFocusTime(w.start, w.end)} className="min-h-8 shrink-0 cursor-pointer rounded px-1 text-primary hover:bg-primary/10">聚焦时段</button></div>
        <DiagnosticsIdentity name={w.accountName} connection={w} onFocus={() => onFocusAccount({ id: w.connectionId }, "byAccount")} />
        <p className="mt-1 text-[11px] text-text-muted">{time(w.start)} — {time(w.end)} · {w.model}</p>
        <p className="mt-2 break-all text-xs leading-5 text-text-muted">{w.overloadCount ? "过载请求关联 Key：" : "该时段调用 Key："}{w.callers.filter(c => !w.overloadCount || c.overloadCount).slice(0, 3).map(c => `${c.name} ${w.overloadCount ? c.overloadCount : c.count} 次`).join("、")}</p>
        <p className="mt-1 text-xs leading-5 text-text-muted">开始响应中位数 {duration(w.firstPacketMedianMs)}{w.baselineP95Ms == null ? ` · 历史样本不足 ${pressure.minBaselineSamples} 条` : ` · 同账号同模型历史 P95 ${duration(w.baselineP95Ms)}`}{w.waitIncrease && <strong className="ml-1 text-amber-700 dark:text-amber-300">等待升高</strong>}</p>
      </div>) : <p className="rounded-xl bg-surface-2 p-4 text-sm leading-6 text-text-muted">所选时段未发现明确过载报告、排队超时或有足够历史样本支持的等待异常。</p>}
    </div>
    <p className="mt-4 border-t border-border-subtle pt-3 text-[11px] leading-5 text-text-muted">关联 Key 表示谁遇到了过载，不能据此认定谁造成过载。等待异常需中位数至少 10 秒，且至少 {pressure?.minWindowSamples || 5} 个成功样本，其中位数高于此前 7 天同账号、同模型的 P95。</p>
    {!!pressure?.queueSamples && <p className="mt-2 text-[11px] leading-5 text-text-muted">失败记录中的本地排队 P95 {duration(pressure.queueWaitP95Ms)}（{pressure.queueSamples} 个样本）</p>}
  </section>;
}
