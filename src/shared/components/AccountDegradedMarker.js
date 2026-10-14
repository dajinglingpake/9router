"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import Modal from "./Modal";
import Button from "./Button";
import Input from "./Input";
import { ACCOUNT_QUALITY_LABELS, ACCOUNT_QUALITY_MAX_LENGTH, ACCOUNT_QUALITY_DEFAULT_COLOR, ACCOUNT_QUALITY_COLORS, getAccountQualityStatus, getAccountQualityLabel, getAccountQualityMarkedAt, getAccountQualityColor, getAccountQualityTextColor } from "@/shared/utils/accountQuality.js";

const icons = { normal: "verified", slow: "schedule", degraded: "flag" };

export default function AccountDegradedMarker({ connection, disabled = false, onUpdated }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftColor, setDraftColor] = useState(ACCOUNT_QUALITY_DEFAULT_COLOR);
  const triggerRef = useRef(null);
  const status = getAccountQualityStatus(connection);
  const qualityLabel = getAccountQualityLabel(connection);
  const qualityColor = getAccountQualityColor(connection);
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
        body: JSON.stringify({ qualityStatus, qualityLabel: qualityStatus === "custom" ? trimmed : null, qualityColor: qualityStatus ? draftColor : null }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存账号标记失败，请重试。");
      onUpdated({
        qualityStatus: getAccountQualityStatus(data.connection),
        qualityLabel: data.connection.qualityLabel ?? null,
        qualityColor: data.connection.qualityColor ?? null,
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
          onClick={() => { setDraft(qualityLabel); setDraftColor(qualityColor); setError(""); setEditing(true); }}
          disabled={saving || disabled}
          data-account-quality={connection.id}
          aria-label={`账号标记：${label}`}
          aria-haspopup="dialog"
          aria-expanded={editing}
          aria-busy={saving}
          title={qualityLabel || "填写账号标记"}
          style={status ? { backgroundColor: qualityColor, borderColor: qualityColor, color: getAccountQualityTextColor(qualityColor) } : undefined}
          className={`inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 ${status ? "shadow-sm ring-1 ring-inset ring-black/15 hover:ring-2 dark:ring-white/25" : "border-border text-text-muted hover:bg-surface-2 hover:text-text-main"}`}
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
            <fieldset className="space-y-3" disabled={saving}>
              <legend className="mb-2 text-sm font-medium text-text-main">标签颜色</legend>
              <div className="grid grid-cols-3 gap-2">
                {ACCOUNT_QUALITY_COLORS.map(color => (
                  <button
                    key={color.value}
                    type="button"
                    onClick={() => setDraftColor(color.value)}
                    aria-label={`选择${color.label}`}
                    aria-pressed={draftColor === color.value}
                    className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border px-2 text-sm text-text-main focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50 ${draftColor === color.value ? "border-primary bg-primary/10" : "border-border hover:bg-surface-2"}`}
                  >
                    <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center rounded-full ring-1 ring-black/15 dark:ring-white/25" style={{ backgroundColor: color.value, color: getAccountQualityTextColor(color.value) }}>
                      {draftColor === color.value && <span className="material-symbols-outlined text-[14px]">check</span>}
                    </span>
                    {color.label}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <label htmlFor={`account-quality-color-${connection.id}`} className="text-sm text-text-main">自选颜色</label>
                <input id={`account-quality-color-${connection.id}`} type="color" value={draftColor} onChange={event => setDraftColor(event.target.value)} className="h-11 w-16 cursor-pointer rounded-lg border border-border bg-surface p-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" />
                <span className="text-xs font-mono text-text-muted">{draftColor}</span>
              </div>
            </fieldset>
            <div className="space-y-2">
              <p className="text-xs text-text-muted">标签预览</p>
              <span data-account-quality-preview className="inline-flex max-w-full break-all rounded-lg px-3 py-2 text-sm font-semibold ring-1 ring-inset ring-black/15 dark:ring-white/25" style={{ backgroundColor: draftColor, color: getAccountQualityTextColor(draftColor) }}>{draft.trim() || "标签预览"}</span>
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
