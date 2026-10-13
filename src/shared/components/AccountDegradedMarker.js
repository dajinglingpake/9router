"use client";

import { useState } from "react";

export default function AccountDegradedMarker({ connection, disabled = false, onUpdated }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const isDegraded = connection.isDegraded === true;
  const markedAt = connection.degradedMarkedAt ? new Date(connection.degradedMarkedAt) : null;
  const hasMarkedAt = markedAt && Number.isFinite(markedAt.getTime());
  const label = connection.name || connection.email || connection.id;

  const toggle = async () => {
    if (saving || disabled) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/providers/${encodeURIComponent(connection.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isDegraded: !isDegraded }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存降智标记失败，请重试。");
      onUpdated({
        isDegraded: data.connection.isDegraded === true,
        degradedMarkedAt: data.connection.degradedMarkedAt ?? null,
      });
    } catch (error) {
      setError(error.message || "保存降智标记失败，请重试。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
      <button
        type="button"
        onClick={toggle}
        disabled={saving || disabled}
        data-account-degraded={connection.id}
        aria-label={`账号降智标记：${label}`}
        aria-pressed={isDegraded}
        aria-busy={saving}
        title={isDegraded ? "已手动标记为降智，点击取消；标记不影响账号路由" : "手动标记输出质量下降；标记不影响账号路由"}
        className={`inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 ${
          isDegraded
            ? "border-amber-500/40 bg-amber-500/10 text-amber-800 hover:bg-amber-500/20 dark:text-amber-300"
            : "border-border-subtle text-text-muted hover:bg-surface-2 hover:text-text-primary"
        }`}
      >
        <span aria-hidden="true" className={`material-symbols-outlined text-[16px] ${saving ? "animate-spin" : ""}`}>
          {saving ? "progress_activity" : "flag"}
        </span>
        <span className={isDegraded ? "font-semibold" : ""}>{isDegraded ? "已降智" : "标记降智"}</span>
        {isDegraded && <span className="text-[11px]">· 取消标记</span>}
      </button>
      {isDegraded && <p className="text-xs text-text-muted">
        {hasMarkedAt
          ? <>标记于 <time dateTime={connection.degradedMarkedAt}>{markedAt.toLocaleString("zh-CN", { hour12: false })}</time></>
          : "标记时间未记录"}
      </p>}
      {error && <p role="alert" className="w-full text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
