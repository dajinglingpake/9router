"use client";

import { useState } from "react";
import { ACCOUNT_QUALITY_LABELS, getAccountQualityStatus, getAccountQualityMarkedAt } from "@/shared/utils/accountQuality.js";

const styles = {
  normal: "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
  slow: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  degraded: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
};
const icons = { normal: "verified", slow: "schedule", degraded: "flag" };

export default function AccountDegradedMarker({ connection, disabled = false, onUpdated }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const status = getAccountQualityStatus(connection);
  const markedAt = getAccountQualityMarkedAt(connection);
  const label = connection.name || connection.email || connection.id;

  const save = async (qualityStatus) => {
    if (saving || disabled) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/providers/${encodeURIComponent(connection.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qualityStatus }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存账号标记失败，请重试。");
      onUpdated({
        qualityStatus: getAccountQualityStatus(data.connection),
        qualityMarkedAt: getAccountQualityMarkedAt(data.connection),
        isDegraded: data.connection.isDegraded === true,
        degradedMarkedAt: data.connection.degradedMarkedAt ?? null,
      });
    } catch (error) {
      setError(error.message || "保存账号标记失败，请重试。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="group/quality mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
      <div className={`relative inline-flex items-center rounded-lg border ${styles[status] || "border-border-subtle text-text-muted"} ${saving || disabled ? "opacity-50" : ""}`}>
        <span aria-hidden="true" className={`pointer-events-none absolute left-2.5 material-symbols-outlined text-[16px] ${saving ? "animate-spin" : ""}`}>
          {saving ? "progress_activity" : icons[status] || "label"}
        </span>
        <select
          value={status || ""}
          onChange={event => save(event.target.value || null)}
          disabled={saving || disabled}
          data-account-quality={connection.id}
          aria-label={`账号标记：${label}`}
          aria-busy={saving}
          title="手动记录账号表现；选择标签可修改标记"
          className="min-h-11 w-32 cursor-pointer appearance-none rounded-lg bg-transparent pl-8 pr-7 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed"
        >
          <option value="" disabled={!status} className="bg-surface text-text-primary">{status ? "取消标记" : "标记账号"}</option>
          {Object.entries(ACCOUNT_QUALITY_LABELS).map(([value, text]) => <option key={value} value={value} className="bg-surface text-text-primary">{text}</option>)}
        </select>
        <span aria-hidden="true" className="pointer-events-none absolute right-2 material-symbols-outlined text-[16px]">expand_more</span>
      </div>
      {status && <p className="text-xs text-text-muted">
        {markedAt
          ? <>标记于 <time dateTime={markedAt}>{new Date(markedAt).toLocaleString("zh-CN", { hour12: false })}</time></>
          : "标记时间未记录"}
      </p>}
      {status && <button
        type="button"
        onClick={() => save(null)}
        disabled={saving || disabled}
        aria-label={`取消账号标记：${label}`}
        className="hidden min-h-11 items-center rounded-lg px-2 text-xs text-text-muted hover:bg-surface-2 hover:text-text-primary focus-visible:outline-2 focus-visible:outline-primary group-hover/quality:inline-flex group-has-[:focus-visible]/quality:inline-flex disabled:cursor-not-allowed [@media(hover:none)]:hidden"
      >取消标记</button>}
      {error && <p role="alert" className="w-full text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
