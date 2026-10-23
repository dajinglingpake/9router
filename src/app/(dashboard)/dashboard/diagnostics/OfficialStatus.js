"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { getAccountOfficialReference, isOfficialStatusStale, OFFICIAL_STATUS_URL } from "@/shared/utils/officialStatus.js";

const StatusContext = createContext(null);
const time = value => value == null ? "—" : new Date(value).toLocaleString("zh-CN", { hour12: false });
const componentLabels = {
  operational: "正常", degraded_performance: "性能下降", partial_outage: "部分故障",
  major_outage: "重大故障", under_maintenance: "维护中",
};
const incidentLabels = { investigating: "调查中", identified: "已定位", monitoring: "观察恢复", resolved: "已解决", postmortem: "已复盘" };
const watchedComponents = ["Codex API", "CLI", "Codex Web", "VS Code extension", "Responses", "Chat Completions"];
const linkClass = "text-primary underline decoration-dotted underline-offset-4 hover:decoration-solid";

function IncidentList({ incidents }) {
  return <ul className="mt-2 space-y-2">
    {incidents.map(incident => <li key={incident.id} className="min-w-0 break-words">
      <a className={linkClass} href={incident.url} target="_blank" rel="noopener noreferrer">{incident.name} ↗</a>
      <span className="ml-2 text-text-muted">{incidentLabels[incident.status] || "状态未知"}</span>
      <p className="mt-0.5 text-text-muted">{time(incident.startedAt)} — {incident.resolved ? time(incident.resolvedAt) : "尚未宣布解决"}</p>
    </li>)}
  </ul>;
}

export default function OfficialStatusProvider({ children }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const request = useRef(null);
  const refresh = useCallback(async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const response = await fetch("/api/usage/official-status", {
        cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) throw new Error("Status unavailable");
      const result = await response.json();
      if (!controller.signal.aborted) setData(result);
    } catch {
      if (!controller.signal.aborted) setData(previous => ({ ...previous, stale: true, error: "暂时无法更新官方状态，请查看官方页面。" }));
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const visibleRefresh = () => { if (document.visibilityState === "visible") refresh(); };
    visibleRefresh();
    const timer = setInterval(visibleRefresh, 60_000);
    document.addEventListener("visibilitychange", visibleRefresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibleRefresh);
      request.current?.abort();
      request.current = null;
    };
  }, [refresh]);

  const stale = isOfficialStatusStale(data);
  const normal = !stale && data.indicator === "none";
  const headline = loading && !data ? "正在读取官方状态…" : stale ? "官方状态未确认"
    : normal ? "官方当前报告：服务正常" : "官方当前报告：存在服务异常";
  return <StatusContext.Provider value={data}>
    <section aria-label="OpenAI 官方服务状态" aria-busy={loading} className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">OpenAI 官方服务状态</h2>
          <p role="status" className={`mt-1 text-sm ${stale ? "text-text-muted" : normal ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}`}>{headline}</p>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <a href={OFFICIAL_STATUS_URL} target="_blank" rel="noopener noreferrer" className={linkClass}>官方状态页 ↗</a>
          <button type="button" disabled={loading} onClick={refresh} className="min-h-9 cursor-pointer rounded-lg border border-border px-3 hover:bg-surface-2 disabled:opacity-50">{loading ? "更新中…" : "刷新状态"}</button>
        </div>
      </div>
      <p className="mt-2 text-xs leading-5 text-text-muted">官方公布的是共享服务可用性，不能判断单个账号是否受限或恢复。请结合下方账号实测、错误和申诉记录查看。</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {watchedComponents.map(name => {
          const component = data?.components?.find(item => item.name === name);
          const label = stale ? "未确认" : componentLabels[component?.status] || "未确认";
          const affected = !stale && component?.status && component.status !== "operational" && componentLabels[component.status];
          return <span key={name} className={`rounded-lg px-2.5 py-1.5 text-xs ${affected ? "bg-amber-500/10 text-amber-700 dark:text-amber-300" : "bg-surface-2 text-text-muted"}`}>{name} · {label}</span>;
        })}
      </div>
      <p className="mt-3 text-xs text-text-muted">{data?.error || (stale && data?.fetchedAt ? "数据已过期，等待重新获取。" : "页面可见时每分钟更新；服务端缓存 60 秒。")}
        {data?.fetchedAt && <> 最近成功获取：{time(data.fetchedAt)}（本地时间）</>}</p>
      {data?.incidents?.length > 0 && <details className="mt-3 border-t border-border pt-3 text-xs leading-5">
        <summary className="cursor-pointer text-text-muted">最近 {data.historyCount} 条官方事件{stale ? "（缓存）" : ""} · 展开查看</summary>
        <p className="mt-2 text-text-muted">最早记录：{time(data.historyOldestAt)}。这是接口返回的有限记录，不保证完整覆盖这段时间；账号关联仅按产品名称和时间初筛，不能确认故障原因。</p>
        <IncidentList incidents={data.incidents} />
        <a href={`${OFFICIAL_STATUS_URL}/history`} target="_blank" rel="noopener noreferrer" className={`${linkClass} mt-3 inline-block`}>查看完整官方历史 ↗</a>
      </details>}
    </section>
    {children}
  </StatusContext.Provider>;
}

export function AccountOfficialStatus({ provider, start, end, windowLabel = "测试时段", className = "" }) {
  const data = useContext(StatusContext);
  const reference = getAccountOfficialReference(data, provider, start, end);
  if (!reference) return null;
  const label = { operational: "当前服务正常", incident: "当前有服务异常", unknown: "当前状态未确认" }[reference.current];
  return <div className={`mt-2 text-xs leading-5 text-text-muted ${className}`}>
    <p className={reference.current === "incident" ? "text-amber-700 dark:text-amber-300" : ""}>官方 {reference.componentNames.join(" / ")}：{label}（共享服务）</p>
    {!reference.hasWindow ? <p>尚无可对照的{windowLabel}。</p>
      : !data?.fetchedAt ? <p>历史事件暂不可用。</p>
        : reference.incidents.length ? <details>
          <summary className="cursor-pointer text-amber-700 dark:text-amber-300">{windowLabel}有 {reference.incidents.length} 条可能相关事件{reference.stale ? "（缓存）" : ""}</summary>
          <p>按产品名称和时间重合初筛，不代表此账号已被确认受影响；公开时间也可能晚于故障实际开始时间。</p>
          <IncidentList incidents={reference.incidents} />
        </details>
          : <p>{reference.stale ? "缓存的" : "最近的"}官方记录中未匹配到同期事件；记录有限，不能据此排除服务故障。</p>}
  </div>;
}
