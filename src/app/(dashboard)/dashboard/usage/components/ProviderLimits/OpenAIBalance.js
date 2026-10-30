"use client";

import { useId, useState } from "react";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";

const money = amount => `${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} USD`;

export default function OpenAIBalance({ balance, connectionId, onSaved }) {
  const inputId = useId();
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const invalidAmount = amount.trim() === "" || !Number.isFinite(Number(amount)) || Number(amount) < 0;

  async function save(value) {
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/providers/${connectionId}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openaiBalanceAmount: value }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存余额失败，请重试。");
      setEditing(false);
      setAmount("");
      await onSaved();
    } catch (error) {
      setError(error.message || "保存余额失败，请重试。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface-2/50 p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-text-main">预计剩余</span>
        {balance?.remaining != null && (
          <span className={`text-sm font-semibold tabular-nums ${balance.remaining <= 0 ? "text-red-600 dark:text-red-400" : "text-text-main"}`}>
            {money(balance.remaining)}
          </span>
        )}
        {!balance && !editing && <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>填写当前余额</Button>}
        {balance && balance.remaining == null && <span className="text-xs text-text-muted">暂无法估算</span>}
      </div>
      {balance && (
        <div className="space-y-1 text-xs text-text-muted">
          <p>记录余额 {money(balance.amount)} · {new Date(balance.recordedAt).toLocaleString()}</p>
          {balance.estimate?.amount != null && <p>记录后估算消费 {money(balance.estimate.amount)}</p>}
          {balance.error && <p role="status" className="text-red-600 dark:text-red-400">{balance.error}</p>}
          {balance.estimate?.unpricedRequests > 0 && <p role="status">有 {balance.estimate.unpricedRequests.toLocaleString()} 次请求缺少适用单价或用量明细，暂无法估算完整余额。</p>}
          <p>按组织模型用量估算。充值或额度到期后，请重新校准余额。</p>
          {!editing && <Button variant="ghost" size="sm" onClick={() => { setError(""); setEditing(true); }}>校准余额</Button>}
        </div>
      )}
      {editing && (
        <form className="space-y-2" onSubmit={event => { event.preventDefault(); if (!invalidAmount && !saving) void save(Number(amount)); }}>
          <label htmlFor={inputId} className="block text-xs font-medium text-text-main">官网当前余额（USD）</label>
          <Input id={inputId} type="number" inputMode="decimal" min="0" step="any" required
            value={amount} onChange={event => { setAmount(event.target.value); setError(""); }} disabled={saving}
            placeholder="0.00" aria-describedby={`${inputId}-hint`} />
          <p id={`${inputId}-hint`} className="text-xs text-text-muted">保存时自动记录时间，从此刻起扣除估算消费。</p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" loading={saving} disabled={invalidAmount}>保存余额</Button>
            <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => { setEditing(false); setAmount(""); setError(""); }}>取消</Button>
            {balance && <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => void save(null)}>清除记录</Button>}
          </div>
        </form>
      )}
      {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
