"use client";

import { Fragment, useEffect, useId, useRef, useState } from "react";
import { Button, Input } from "@/shared/components";

const metrics = { rpm: "RPM", tpm: "TPM", rpd: "RPD" };
const views = [
  { value: "rpd", label: "每日请求" },
  { value: "rpm", label: "分钟请求" },
  { value: "tpm", label: "分钟输入" },
];
const descriptions = { rpd: "RPD · 按美国太平洋时间零点重置", rpm: "RPM · 最近 60 秒的请求", tpm: "TPM · 最近 60 秒的输入 Token" };
const previewRows = 3;
const format = value => Number.isFinite(value) ? value.toLocaleString("zh-CN") : "—";

function rowsForMetric(usage, metric) {
  const rank = row => {
    const limit = row.limits[metric];
    if (limit == null) return 2;
    return limit === 0 ? 1 : 0;
  };
  return [...usage.models].sort((a, b) => rank(a) - rank(b) || b[metric] - a[metric] || b.rpd - a.rpd || a.model.localeCompare(b.model));
}

export default function GeminiQuota({ connectionId, usage, detailUrl, onSaved }) {
  const listId = useId();
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [metric, setMetric] = useState("rpd");
  const [showAll, setShowAll] = useState(false);
  const [detailModel, setDetailModel] = useState(null);
  const editTrigger = useRef(null);
  const editing = form !== null;
  useEffect(() => {
    if (editing || saving || !editTrigger.current) return;
    const trigger = editTrigger.current;
    editTrigger.current = null;
    const target = trigger.isConnected ? trigger : document.getElementById(`${listId}-add`);
    target?.focus();
  }, [editing, saving, listId]);

  function edit(model = "", trigger) {
    editTrigger.current = trigger;
    const row = usage.models.find(row => row.model === model);
    setForm({ model, chooseModel: !model, value: row?.limits[metric] ?? "" });
    requestAnimationFrame(() => document.getElementById(`${listId}-${model ? "limit" : "model"}`)?.focus());
    setError("");
  }

  function closeEditor() {
    setForm(null);
  }

  async function save(event) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    const limit = form.value === "" ? null : Number(form.value);
    try {
      const response = await fetch(`/api/usage/${connectionId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: form.model, metric, limit }),
      });
      if (!response.ok) throw new Error((await response.json()).error || "保存额度失败。");
      await onSaved();
      closeEditor();
    } catch (e) {
      setError(e.message || "保存额度失败，请重试。");
    } finally {
      setSaving(false);
    }
  }

  const totals = usage.models.reduce((sum, row) => ({
    requests: sum.requests + row.rpd, input: sum.input + row.inputTokens, output: sum.output + row.outputTokens,
  }), { requests: 0, input: 0, output: 0 });
  const rows = rowsForMetric(usage, metric);
  const shown = showAll ? rows : rows.slice(0, previewRows);
  const snapshotTime = usage.snapshot?.observedAt;
  const metricLabel = views.find(view => view.value === metric).label;
  const formDefault = usage.models.find(row => row.model === form?.model)?.defaultLimits?.[metric];
  return (
    <div data-gemini-quota className="@container min-w-0 space-y-1 text-xs">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <p className="tabular-nums">本站今日 <strong className="font-semibold">{format(totals.requests)} 次</strong>
          <span className="ml-2 text-text-muted">输入 {format(totals.input)} / 输出 {format(totals.output)} Token</span>
        </p>
        <a className="inline-flex items-center gap-0.5 text-primary hover:underline" href={detailUrl} target="_blank" rel="noopener noreferrer" aria-label="查看 Google 官方额度">
          官方额度<span aria-hidden="true" className="material-symbols-outlined" style={{ fontSize: 12 }}>open_in_new</span>
        </a>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <select aria-label="配额指标" value={metric} disabled={editing} onChange={e => setMetric(e.target.value)}
          className="h-7 rounded border border-border bg-surface px-1 text-xs focus-visible:outline-primary">
          {views.map(view => <option key={view.value} value={view.value}>{view.label}（{metrics[view.value]}）</option>)}
        </select>
        <button id={`${listId}-add`} type="button" className="ml-auto min-h-7 rounded px-1 text-primary hover:underline" aria-label="调整模型上限"
          disabled={editing || saving} onClick={e => edit("", e.currentTarget)}>调整上限</button>
      </div>
      {form && (
        <form onSubmit={save} aria-label="调整模型上限" className="space-y-2 rounded-lg border border-border bg-surface-2/50 p-2">
          {form.chooseModel ? <>
            <Input id={`${listId}-model`} label="模型 ID" list={listId} required disabled={saving} value={form.model} onChange={e => {
              const model = e.target.value;
              setForm({ ...form, model, value: usage.models.find(row => row.model === model)?.limits[metric] ?? "" });
            }} />
            <datalist id={listId}>{rows.map(row => <option key={row.model} value={row.model} />)}</datalist>
          </> : <code className="block break-all">{form.model}</code>}
          <Input id={`${listId}-limit`} label={`${metricLabel}上限（${metrics[metric]}）`} type="number" min="0" step="1" max={Number.MAX_SAFE_INTEGER}
            disabled={saving} value={form.value} placeholder={formDefault == null ? "未设置" : String(formDefault)}
            inputClassName="max-w-40 py-1.5" onChange={e => setForm({ ...form, value: e.target.value })} />
          <p className="text-text-muted">{formDefault == null ? "此模型暂无默认上限，留空保存可清除设置。" : `免费层默认 ${format(formDefault)}，留空保存可恢复默认。`}</p>
          {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={saving || !form.model.trim()}>{saving ? "保存中…" : "保存额度"}</Button>
            <Button type="button" size="sm" variant="secondary" disabled={saving} onClick={closeEditor}>取消</Button>
          </div>
        </form>
      )}
      {rows.length ? (
        <table className="w-full table-fixed text-left text-xs tabular-nums">
          <caption className="sr-only">{metricLabel}额度</caption>
          <thead className="border-y border-border-subtle bg-surface-2 text-text-muted"><tr>
            <th scope="col" className="px-1 py-1 font-medium">模型</th>
            <th scope="col" className="w-[4.5rem] whitespace-nowrap px-1 text-right font-medium @md:w-24" title="估算剩余 / 设定上限">估算剩余<span className="hidden @md:inline"> / 上限</span></th>
            <th scope="col" className="w-14 px-1 text-right font-medium">本站已用</th>
            <th scope="col" className="w-7"><span className="sr-only">操作</span></th>
          </tr></thead>
          <tbody className="divide-y divide-border-subtle">{shown.map(row => {
            const limit = row.limits[metric];
            const used = metric === "rpd" ? row.estimatedRpd ?? row.rpd : row[metric];
            const remaining = limit == null ? null : Math.max(0, limit - used);
            const sample = usage.snapshot?.models?.[row.model]?.[metric];
            const open = detailModel === row.model;
            const detailId = `${listId}-detail-${row.model}`;
            return (
              <Fragment key={row.model}>
                <tr>
                  <th scope="row" className="px-1 text-left font-normal">
                    <button type="button" className="flex h-8 w-full items-center gap-0.5 rounded text-left hover:text-primary focus-visible:outline-primary"
                      aria-label={`查看 ${row.model} 用量明细`} aria-expanded={open} aria-controls={open ? detailId : undefined}
                      title={row.model} onClick={() => setDetailModel(open ? null : row.model)}>
                      <code className="min-w-0 line-clamp-2 leading-[14px] [overflow-wrap:anywhere] @md:line-clamp-none @md:truncate">
                        {row.model.startsWith("gemini-") ? <><span className="hidden @md:inline">gemini-</span>{row.model.slice("gemini-".length)}</> : row.model}
                      </code>
                      <span aria-hidden="true" className="material-symbols-outlined shrink-0 text-text-subtle" style={{ fontSize: 12 }}>{open ? "expand_less" : "expand_more"}</span>
                    </button>
                  </th>
                  <td className="px-1 text-right [overflow-wrap:anywhere]">
                    <strong className="font-semibold">{format(remaining)}</strong>{limit != null && <> <span className="inline-block max-w-full text-text-muted">/ {format(limit)}</span></>}
                  </td>
                  <td className="px-1 text-right">
                    {format(row[metric])}
                  </td>
                  <td className="text-right">
                    <button type="button" className="inline-flex h-8 w-7 items-center justify-center rounded text-text-muted hover:bg-surface-2 hover:text-primary focus-visible:outline-primary"
                      disabled={editing || saving} title="调整上限" aria-label={`编辑 ${row.model} 额度`} onClick={e => edit(row.model, e.currentTarget)}>
                      <span aria-hidden="true" className="material-symbols-outlined" style={{ fontSize: 16 }}>edit</span>
                    </button>
                  </td>
                </tr>
                {open && <tr id={detailId}>
                  <td colSpan={4} className="bg-surface-2 px-2 py-1 text-text-muted">
                    <code className="block break-all text-text-main">{row.model}</code>
                    <p>本站已用 {format(row[metric])} · {limit == null ? "上限未设置" : `${limit === row.defaultLimits?.[metric] ? "免费层默认上限" : "自定义上限"} ${format(limit)}`}</p>
                    {sample && snapshotTime && <p>Google 历史读数（{new Date(snapshotTime).toLocaleString("zh-CN", { hour12: false })}）已用 {format(sample.used)} / {format(sample.limit)}</p>}
                  </td>
                </tr>}
              </Fragment>
            );
          })}</tbody>
        </table>
      ) : <p className="text-sm text-text-muted">此连接暂无模型用量或额度记录。</p>}
      <div className="flex flex-wrap items-baseline justify-between gap-1">
        <details className="max-w-prose text-xs text-text-muted">
          <summary className="w-fit cursor-pointer rounded py-1 hover:text-text-main">统计口径</summary>
          <p className="mt-1 leading-relaxed">{descriptions[metric]}。{metric !== "tpm" && "收到 Google 响应即计一次，包括繁忙和重试。"}{metric === "rpd" && usage.useDailySnapshot
            ? "有当日 Google 读数时，估算已用量取本站今日用量与“官方已用量加核对后的本站请求”中的较大值。"
            : "估算剩余按设定上限扣除此连接的本站用量。"} “—”表示暂无对应数据。</p>
        </details>
        {rows.length > previewRows && <button type="button" aria-expanded={showAll} onClick={() => setShowAll(v => !v)}
          className="rounded px-1 py-1 text-xs font-medium text-primary hover:underline">
          {showAll ? "收起模型" : `查看全部 ${rows.length} 个模型`}
        </button>}
      </div>
    </div>
  );
}
