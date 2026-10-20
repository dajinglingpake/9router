"use client";

import { useEffect, useState } from "react";
import AccountDegradedMarker from "@/shared/components/AccountDegradedMarker";
import Button from "@/shared/components/Button";

async function request(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "读取或保存账号失败，请重试。");
  return data.connection;
}

export default function AccountActions({ connectionId }) {
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  const url = `/api/providers/${encodeURIComponent(connectionId)}`;

  useEffect(() => {
    const controller = new AbortController();
    request(url, { signal: controller.signal })
      .then(connection => { if (!controller.signal.aborted) setAccount(connection); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [url, attempt]);

  async function toggleActive() {
    if (!account || saving) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const updated = await request(url, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: account.isActive === false }),
      });
      setAccount(previous => ({ ...previous, isActive: updated.isActive }));
      setNotice(updated.isActive === false ? "账号已禁用。" : "账号已启用。");
    } catch (cause) { setError(cause.message); }
    finally { setSaving(false); }
  }

  const active = account?.isActive !== false;
  return <section aria-label="账号管理" className="space-y-3 rounded-xl border border-border bg-surface p-4">
    {loading ? <p role="status" className="text-sm text-text-muted">正在读取账号状态…</p>
      : account && <>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold">账号状态</span>
          <span className={`rounded-full px-2.5 py-1 text-xs ${active ? "bg-green-500/10 text-green-700 dark:text-green-400" : "bg-surface-2 text-text-muted"}`}>{active ? "已启用" : "已禁用"}</span>
          <Button size="sm" variant="secondary" icon={active ? "pause" : "play_arrow"} loading={saving} onClick={toggleActive}>{active ? "禁用账号" : "启用账号"}</Button>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-sm font-semibold">标签备注</span>
          <AccountDegradedMarker connection={account} disabled={saving} onUpdated={updates => {
            setAccount(previous => ({ ...previous, ...updates }));
            setNotice("标签备注已保存。");
          }} />
        </div>
      </>}
    {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    {!loading && !account && <Button size="sm" variant="secondary" onClick={() => { setLoading(true); setError(""); setAttempt(n => n + 1); }}>重新读取账号</Button>}
    {notice && <p role="status" className="text-xs text-text-muted">{notice}</p>}
  </section>;
}
