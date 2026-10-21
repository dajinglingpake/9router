"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import AccountDegradedMarker from "@/shared/components/AccountDegradedMarker";
import EditConnectionModal from "@/shared/components/EditConnectionModal";
import Button from "@/shared/components/Button";
import AccountAppealLink from "@/shared/components/AccountAppealLink";
import AccountAppealHistory from "@/shared/components/AccountAppealHistory";

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "读取或保存账号失败，请重试。");
  return data;
}

export default function CodexTrialAccountActions({ account, onUpdated }) {
  const [connection, setConnection] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const url = `/api/providers/${encodeURIComponent(account.id)}`;

  async function edit() {
    setLoading(true); setError("");
    try {
      // Fetch the complete editable settings only when opening the existing editor.
      const data = await requestJson(url, { cache: "no-store" });
      setConnection(data.connection);
    } catch (cause) { setError(cause.message); }
    finally { setLoading(false); }
  }

  async function save(updates) {
    await requestJson(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(updates) });
    setConnection(null);
    onUpdated();
  }

  async function toggleActive() {
    if (saving) return;
    setSaving(true); setError("");
    try {
      await requestJson(url, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !account.enabled }),
      });
      await onUpdated();
    } catch (cause) { setError(cause.message); }
    finally { setSaving(false); }
  }

  return <>
    <div className="mt-2 flex flex-wrap items-center gap-x-2">
      <AccountDegradedMarker connection={account} onUpdated={onUpdated} />
      <Button size="sm" variant="secondary" icon={account.enabled ? "pause" : "play_arrow"}
        loading={saving} disabled={loading} onClick={toggleActive}
        aria-label={`${account.enabled ? "禁用" : "启用"}账号：${account.name}`}>
        {account.enabled ? "禁用账号" : "启用账号"}
      </Button>
      <Button size="sm" variant="ghost" icon="edit" loading={loading} disabled={saving} onClick={edit}
        aria-label={`编辑账号：${account.name}`}>编辑账号</Button>
      {account.provider === "codex" && <AccountAppealLink account={account} />}
    </div>
    {account.provider === "codex" && <AccountAppealHistory connectionId={account.id} accountName={account.name} summary={account.appealHistory} onUpdated={onUpdated} />}
    {error && <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    {connection && createPortal(<EditConnectionModal isOpen connection={connection}
      onSave={save} onClose={() => setConnection(null)} />, document.body)}
  </>;
}
