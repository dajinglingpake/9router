"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import CodexSharedQuotaGroups from "@/shared/components/CodexSharedQuotaGroups";
import { AUTO_REFRESH_STORAGE_KEY, REFRESH_INTERVAL_MS } from "../../usage/components/ProviderLimits/utils";

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
    const initialRefresh = setTimeout(() => void refresh(), 0);
    const timer = setInterval(autoRefresh, REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", autoRefresh);
    return () => {
      clearTimeout(initialRefresh);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", autoRefresh);
      controllerRef.current?.abort(); controllerRef.current = null;
    };
  }, [refresh]);

  return <Card className="mb-4" padding="sm" aria-label="Codex 额度汇总">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">Codex 额度汇总</h2>
        <p className="text-xs text-text-muted">汇总所有已启用的 Codex 账号，共享额度按套餐分组。</p>
      </div>
      <Button size="sm" variant="secondary" icon="refresh" disabled={loading} onClick={() => refresh(true)}>刷新额度</Button>
    </div>
    {error && <p role="alert" className="mt-3 text-sm text-red-500">{error}{summary ? "，下方保留上次结果。" : ""}</p>}
    {loading && !summary && <p role="status" className="mt-3 text-sm text-text-muted">正在汇总 Codex 额度…</p>}
    {summary && <>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
        <span>启用账号：{summary.accountCount} 个</span>
        <span>共享账号：{summary.sharedAccountCount} 个</span>
        <span>专用账号：{summary.dedicatedAccountCount} 个</span>
        <span>更新时间：{new Date(summary.generatedAt).toLocaleTimeString("zh-CN", { hour12: false })}</span>
      </div>
      {!summary.accountCount && <p className="mt-3 text-sm text-text-muted">暂无启用的 Codex 账号。</p>}
      <CodexSharedQuotaGroups summary={summary} showEstimates />
      {summary.accountCount > 0 && <p className="mt-3 text-xs text-text-muted">美元等值使用近 14 天 9Router 记录的 API 费用，在同一重置周期内观察到至少 5 个百分点的额度降幅后计算。其他客户端的用量也可能影响估算。</p>}
      {summary.sharedAccountCount > 0 && <p className="mt-3 text-xs text-text-muted">5 小时与每周分别判断告警，同时触发合并通知。</p>}
    </>}
  </Card>;
}
