"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import Modal from "./Modal";
import Button from "./Button";
import Input from "./Input";
import { ACCOUNT_QUALITY_LABELS, ACCOUNT_QUALITY_MAX_LENGTH, getAccountQualityStatus, getAccountQualityLabel, getAccountQualityMarkedAt } from "@/shared/utils/accountQuality.js";

const icons = { normal: "verified", slow: "schedule", degraded: "flag" };

export default function AccountDegradedMarker({ connection, disabled = false, onUpdated }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const triggerRef = useRef(null);
  const status = getAccountQualityStatus(connection);
  const qualityLabel = getAccountQualityLabel(connection);
  const markedAt = getAccountQualityMarkedAt(connection);
  const label = connection.name || connection.email || connection.id;

  const closeEditor = () => {
    if (saving) return;
    setEditing(false);
    triggerRef.current?.focus();
  };

  const save = async (text) => {
    if (saving || disabled) return;
    const trimmed = text?.trim() || "";
    const qualityStatus = trimmed
      ? Object.keys(ACCOUNT_QUALITY_LABELS).find(key => ACCOUNT_QUALITY_LABELS[key] === trimmed) || "custom"
      : null;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/providers/${encodeURIComponent(connection.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qualityStatus, qualityLabel: qualityStatus === "custom" ? trimmed : null }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存账号标记失败，请重试。");
      onUpdated({
        qualityStatus: getAccountQualityStatus(data.connection),
        qualityLabel: data.connection.qualityLabel ?? null,
        qualityMarkedAt: getAccountQualityMarkedAt(data.connection),
        isDegraded: data.connection.isDegraded === true,
        degradedMarkedAt: data.connection.degradedMarkedAt ?? null,
      });
      setEditing(false);
      requestAnimationFrame(() => triggerRef.current?.focus());
    } catch (error) {
      setError(error.message || "保存账号标记失败，请重试。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="group/quality mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => { setDraft(qualityLabel); setError(""); setEditing(true); }}
          disabled={saving || disabled}
          data-account-quality={connection.id}
          aria-label={`账号标记：${label}`}
          aria-haspopup="dialog"
          aria-expanded={editing}
          aria-busy={saving}
          title={qualityLabel || "填写账号标记"}
          className={`inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 ${status ? "border-brand-700 bg-brand-700 text-white shadow-sm hover:border-brand-800 hover:bg-brand-800 dark:border-brand-300 dark:hover:border-brand-200" : "border-border text-text-muted hover:bg-surface-2 hover:text-text-main"}`}
        >
          <span aria-hidden="true" className={`shrink-0 material-symbols-outlined text-[16px] ${saving ? "animate-spin" : ""}`}>
            {saving ? "progress_activity" : icons[status] || "label"}
          </span>
          <span className="min-w-0 break-all text-left font-semibold">{qualityLabel || "标记账号"}</span>
          <span aria-hidden="true" className="shrink-0 material-symbols-outlined text-[16px]">edit</span>
        </button>
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
        {error && !editing && <p role="alert" className="w-full text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>
      {editing && createPortal(
        <Modal isOpen onClose={closeEditor} title="编辑账号标记" showTrafficLights={false} closeOnOverlay={!saving}>
          <form
            role="dialog"
            aria-modal="true"
            aria-label={`编辑账号标记：${label}`}
            className="space-y-4"
            onSubmit={event => { event.preventDefault(); if (draft.trim()) save(draft); }}
            onKeyDown={event => {
              if (event.key !== "Tab") return;
              const controls = [...event.currentTarget.querySelectorAll("input:not(:disabled), button:not(:disabled)")];
              const first = controls[0], last = controls[controls.length - 1];
              if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
              if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }}
          >
            <p className="break-all text-sm text-text-muted">{label}</p>
            <div className="space-y-1.5">
              <label htmlFor={`account-quality-${connection.id}`} className="text-sm font-medium text-text-main">标签内容</label>
              <Input
                id={`account-quality-${connection.id}`}
                autoFocus
                value={draft}
                onChange={event => setDraft(event.target.value)}
                disabled={saving}
                maxLength={ACCOUNT_QUALITY_MAX_LENGTH}
                placeholder="例如：中午未降智，下午突然降智"
                hint={`可自由填写，最多 ${ACCOUNT_QUALITY_MAX_LENGTH} 个字符`}
                inputClassName="min-h-11"
              />
            </div>
            <div className="flex flex-wrap gap-2" aria-label="常用标签">
              {Object.values(ACCOUNT_QUALITY_LABELS).map(text => (
                <Button key={text} type="button" variant="secondary" size="lg" className="px-3 focus-visible:outline-2 focus-visible:outline-primary" disabled={saving} aria-pressed={draft.trim() === text} onClick={() => setDraft(text)}>{text}</Button>
              ))}
            </div>
            {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border-subtle pt-4">
              {status && <Button type="button" variant="ghost" size="lg" className="mr-auto px-3" onClick={() => save(null)} disabled={saving || disabled}>取消标记</Button>}
              <Button type="button" variant="ghost" size="lg" className="px-3" onClick={closeEditor} disabled={saving}>取消</Button>
              <Button type="submit" size="lg" className="px-3" loading={saving} disabled={!draft.trim() || disabled}>保存</Button>
            </div>
          </form>
        </Modal>, document.body
      )}
    </>
  );
}
