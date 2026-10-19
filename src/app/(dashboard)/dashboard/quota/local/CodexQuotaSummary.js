"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import { AUTO_REFRESH_STORAGE_KEY, REFRESH_INTERVAL_MS } from "../../usage/components/ProviderLimits/utils";

const planLabel = plan => ({ plus: "Plus", pro: "Pro", free: "Free", team: "Team", business: "Business", enterprise: "Enterprise", unknown: "套餐未提供" })[plan] || plan;

function QuotaMetric({ title, quota, accountCount }) {
  const known = quota.knownAccounts > 0;
  const color = quota.remainingPercent <= 10 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400";
  return <div className="min-w-0 rounded-xl border border-border-subtle bg-bg p-4">
    <p className="text-sm text-text-muted">{title}</p>
    <p className={`mt-1 text-2xl font-semibold tabular-nums ${known ? color : "text-text-muted"}`}>
      {known ? `${quota.remainingPercent.toFixed(1)}%` : "暂无数据"}
    </p>
    {known && <>
      <p className="mt-1 text-sm text-text-primary tabular-nums">约 {quota.equivalentAccounts.toFixed(2)} / {quota.knownAccounts} 个满额账号</p>
      <div role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={quota.remainingPercent}
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-3">
        <div className={quota.remainingPercent <= 10 ? "h-full bg-red-500" : "h-full bg-emerald-500"} style={{ width: `${quota.remainingPercent}%` }} />
      </div>
    </>}
    {quota.accountCount < accountCount && <p className="mt-2 text-xs text-text-muted">此周期适用于 {quota.accountCount} / {accountCount} 个账号</p>}
    {quota.knownAccounts < quota.accountCount && <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">已获取 {quota.knownAccounts} / {quota.accountCount} 个账号，汇总尚不完整</p>}
  </div>;
}

export default function CodexQuotaSummary() {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const controllerRef = useRef(null);

  const refresh = useCallback(async (force = false) => {
    if (controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/usage/codex-summary${force ? "?force=1" : ""}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("读取 Codex 额度汇总失败，请重试");
      const data = await response.json();
      if (!controller.signal.aborted) setSummary(data);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure.message);
    } finally {
      if (!controller.signal.aborted) { setLoading(false); controllerRef.current = null; }
    }
  }, []);

  useEffect(() => {
    const autoRefresh = () => {
      if (!document.hidden && window.localStorage.getItem(AUTO_REFRESH_STORAGE_KEY) !== "false") void refresh();
    };
    void refresh();
    const timer = setInterval(autoRefresh, REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", autoRefresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", autoRefresh);
      controllerRef.current?.abort(); controllerRef.current = null;
    };
  }, [refresh]);

  return <Card className="mb-4" padding="sm" aria-label="Codex 额度汇总">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">Codex 额度汇总</h2>
        <p className="text-xs text-text-muted">覆盖所有分页的启用账号；共享额度按套餐汇总，专用额度按账号单独展示。</p>
      </div>
      <Button size="sm" variant="secondary" icon="refresh" disabled={loading} onClick={() => refresh(true)}>刷新额度</Button>
    </div>
    {error && <p role="alert" className="mt-3 text-sm text-red-500">{error}{summary ? "，下方保留上次结果。" : ""}</p>}
    {loading && !summary && <p role="status" className="mt-3 text-sm text-text-muted">正在汇总全部账号额度…</p>}
    {summary && <>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
        <span>启用账号：{summary.accountCount} 个</span>
        <span>共享账号：{summary.sharedAccountCount} 个</span>
        <span>专用账号：{summary.dedicatedAccountCount} 个</span>
        <span>更新时间：{new Date(summary.generatedAt).toLocaleTimeString("zh-CN", { hour12: false })}</span>
      </div>
      {!summary.accountCount && <p className="mt-3 text-sm text-text-muted">暂无启用的 Codex 账号。</p>}
      {summary.groups.map(group => <section key={group.key} aria-label={group.scope === "dedicated" ? `专用额度 · ${group.name}` : `共享额度 · ${planLabel(group.plan)}`} className="mt-4">
        <h3 className="mb-2 text-sm font-medium text-text-primary">{group.scope === "dedicated" ? `专用额度 · ${group.name}` : "共享额度"} · {planLabel(group.plan)} · {group.accountCount} 个账号<span className="ml-2 text-xs text-text-muted">已耗尽 {group.depletedAccounts} 个</span></h3>
        {group.scope === "dedicated" && <p className="mb-2 break-all text-xs text-primary">绑定人员：{group.exclusiveApiKeyIds.map((id, index) => group.exclusiveApiKeyNames[index] || `已绑定 Key（${id.slice(0, 8)}）`).join("、")}</p>}
        {group.sharedWeeklyAccounts > 0 && <p className="mb-2 text-xs text-text-muted">{group.sharedWeeklyAccounts === group.accountCount ? "5 小时与每周使用同一份额度。" : `${group.sharedWeeklyAccounts} 个账号的 5 小时额度与周额度共用。`}</p>}
        <div className={`grid grid-cols-1 gap-3 ${group.session.accountCount && group.weekly.accountCount ? "sm:grid-cols-2" : ""}`}>
          {group.session.accountCount > 0 && <QuotaMetric title="5 小时剩余" quota={group.session} accountCount={group.accountCount} />}
          {group.weekly.accountCount > 0 && <QuotaMetric title="每周剩余" quota={group.weekly} accountCount={group.accountCount} />}
        </div>
      </section>)}
      {summary.accountCount > 0 && <p className="mt-3 text-xs text-text-muted">共享与专用额度独立判断告警，专用账号达到阈值时 @ 绑定人员。5 小时与每周分别判断，同时触发合并通知。满额账号为同套餐的等效估算，无法精确换算 Token 或请求次数。此处汇总普通额度。</p>}
    </>}
  </Card>;
}
