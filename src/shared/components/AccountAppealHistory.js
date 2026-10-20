"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Button from "./Button";
import Modal from "./Modal";
import { APPEAL_RESULTS, APPEAL_NOTE_LIMIT, appealResultLabel } from "@/shared/utils/accountAppeals";

const date = value => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
const endpoint = (connectionId, extra = {}) => `/api/account-appeals/history?${new URLSearchParams({ connectionId, ...extra })}`;
async function request(url, options) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "读取或保存申诉记录失败。");
  return data;
}

function Conversation({ connectionId, threadId, onSaved }) {
  const [record, setRecord] = useState(null);
  const [result, setResult] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    request(endpoint(connectionId, { threadId }), { signal: controller.signal }).then(data => {
      if (controller.signal.aborted) return;
      setRecord(data); setResult(data.result || ""); setNote(data.note || "");
    }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [connectionId, threadId, attempt]);

  async function save(event) {
    event.preventDefault(); setSaving(true); setError(""); setSaved(false);
    try {
      const updated = await request("/api/account-appeals/history", { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId, threadId, result: result || null, note }) });
      setRecord(previous => ({ ...previous, ...updated })); setNote(updated.note); setSaved(true); onSaved(updated);
    } catch (cause) { setError(cause.message); }
    finally { setSaving(false); }
  }
  if (!record) return <div className="space-y-3 text-sm text-text-muted">
    {error ? <><p role="alert" className="text-red-600">{error}</p><Button size="sm" variant="secondary" onClick={() => { setError(""); setAttempt(n => n + 1); }}>重新读取对话</Button></> : <p role="status">正在读取对话…</p>}
  </div>;
  return <div className="min-w-0 space-y-4">
    <p className="text-xs text-text-muted">对话开始于 {date(record.createdAt)} · 最近同步 {date(record.updatedAt)}</p>
    <div className="max-h-[40vh] space-y-3 overflow-y-auto rounded-lg border border-border bg-surface-2 p-3" aria-label="已保存的客服对话">
      {record.messages.map(message => <article key={message.id} className="rounded-lg border border-border bg-surface p-3">
        <p className="mb-2 flex flex-wrap gap-x-3 text-xs text-text-muted"><strong className="text-text-main">{message.role === "user" ? "我" : "客服"}</strong><time>{date(message.createdAt)}</time>{!message.complete && <span>回复尚未结束</span>}</p>
        <p className="whitespace-pre-wrap break-words text-sm leading-6">{message.text}</p>
        {message.truncated && <p className="mt-2 text-xs text-amber-700">消息过长，仅保存了前 100,000 个字符。</p>}
      </article>)}
    </div>
    <form onSubmit={save} className="space-y-3" aria-label="申诉处理结果">
      <label className="block space-y-1 text-sm font-medium">处理结果
        <select value={result} disabled={saving} onChange={event => { setResult(event.target.value); setSaved(false); }} className="mt-1 block min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm">
          <option value="">按对话自动显示</option>
          {Object.entries(APPEAL_RESULTS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label className="block space-y-1 text-sm font-medium">结果备注
        <textarea rows={3} maxLength={APPEAL_NOTE_LIMIT} value={note} disabled={saving} onChange={event => { setNote(event.target.value); setSaved(false); }} placeholder="例如：已转人工处理，等待邮件回复。" className="mt-1 block w-full resize-y rounded-lg border border-border bg-surface p-3 text-sm" />
      </label>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <div className="flex items-center gap-3"><Button type="submit" size="sm" loading={saving}>保存结果和备注</Button>{saved && <p role="status" className="text-xs text-emerald-700">已保存</p>}</div>
    </form>
  </div>;
}

function HistoryDialog({ connectionId, accountName, onClose, onUpdated }) {
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    request(endpoint(connectionId, { offset: String(offset) }), { signal: controller.signal }).then(payload => {
      if (controller.signal.aborted) return;
      setData(previous => ({ ...payload, items: offset ? [...(previous?.items || []), ...payload.items] : payload.items }));
      setSelected(previous => previous || payload.items[0]?.id || null);
    }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [connectionId, offset, revision]);
  const reload = () => { setLoading(true); setError(""); setOffset(0); setRevision(n => n + 1); };
  return <Modal isOpen onClose={onClose} title="申诉历史" size="full" showTrafficLights={false} blurBackdrop={false} footer={<Button variant="secondary" onClick={onClose}>关闭</Button>}>
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><p className="break-all text-sm text-text-muted">{accountName || connectionId}</p><Button size="sm" variant="secondary" loading={loading} onClick={reload} icon="refresh">刷新记录</Button></div>
    <p className="mb-4 text-xs text-text-muted">这里展示已保存的客服对话。关闭申诉窗口后收到的新回复，需要重新打开对应对话后同步。</p>
    {error && <p role="alert" className="mb-3 text-sm text-red-600">{error}</p>}
    {!loading && !data?.items.length && <p className="py-8 text-center text-sm text-text-muted">暂无申诉记录。发送或查看客服对话后会自动保存，未发送的草稿不会记录。</p>}
    {!!data?.items.length && <div className="grid items-start gap-4 md:grid-cols-[210px_minmax(0,1fr)]">
      <div className="max-h-[55vh] space-y-2 overflow-y-auto" aria-label="历史申诉列表">
        {data.items.map(item => <button key={item.id} type="button" aria-pressed={selected === item.id} onClick={() => setSelected(item.id)} className={`w-full rounded-lg border p-3 text-left ${selected === item.id ? "border-primary bg-primary/5" : "border-border hover:bg-surface-2"}`}>
          <span className="block text-sm font-semibold">{appealResultLabel(item)}</span><time className="mt-1 block text-xs text-text-muted">{date(item.createdAt)}</time><span className="mt-1 block text-xs text-text-muted">{item.messageCount} 条消息</span>
          {item.note && <span className="mt-2 line-clamp-2 break-words text-xs">{item.note}</span>}
        </button>)}
        {data.hasMore && <Button size="sm" variant="secondary" fullWidth loading={loading} onClick={() => { setLoading(true); setError(""); setOffset(data.items.length); }}>加载更早记录</Button>}
      </div>
      {selected && <Conversation key={`${selected}:${revision}`} connectionId={connectionId} threadId={selected} onSaved={updated => {
        setData(previous => ({ ...previous, items: previous.items.map(item => item.id === updated.id ? updated : item) })); onUpdated?.();
      }} />}
    </div>}
  </Modal>;
}

export default function AccountAppealHistory({ connectionId, accountName, summary, onUpdated }) {
  const [open, setOpen] = useState(false);
  const latest = summary?.latest;
  return <div className="mt-2 min-w-0">
    <button type="button" onClick={() => setOpen(true)} className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-primary hover:bg-primary/5" aria-label={`查看申诉历史：${accountName || connectionId}`}>
      <span aria-hidden="true" className="material-symbols-outlined text-[16px]">history</span>申诉记录{summary?.count ? ` · ${summary.count}` : ""}
      {latest && <span className="font-normal">· {appealResultLabel(latest)}</span>}
    </button>
    {latest && <p className="line-clamp-2 break-words px-2 text-xs leading-5 text-text-muted" title={latest.note || latest.lastReply || ""}>{latest.note || latest.lastReply || `最近申诉：${date(latest.createdAt)}`}</p>}
    {open && createPortal(<HistoryDialog connectionId={connectionId} accountName={accountName} onUpdated={onUpdated} onClose={() => setOpen(false)} />, document.body)}
  </div>;
}
