"use client";

import { useState } from "react";
import Badge from "./Badge";

export default function AccountOverloadWarning({ connection, onCleared }) {
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState("");
  const warning = connection.overloadWarning;
  if (!warning) return null;

  const clear = async () => {
    setClearing(true);
    setError("");
    try {
      const response = await fetch(`/api/providers/${encodeURIComponent(connection.id)}/overload-warning`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: warning.eventId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error("Unable to clear warning");
      onCleared(data.overloadWarning);
    } catch {
      setError("清除失败，请重试");
    } finally {
      setClearing(false);
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-account-overload-warning={connection.id}>
      <span title={`该账号曾收到上游过载或暂不可用错误（503）。最近一次：${new Date(warning.lastAt).toLocaleString()}。此标记表示历史记录，当前状态请看账号状态。`}>
        <Badge variant="warning" size="sm" icon="warning">曾经过载</Badge>
      </span>
      <button
        type="button"
        onClick={clear}
        disabled={clearing}
        aria-label="清除过载警告"
        title="清除警告，保留历史日志和当前冷却状态；再次过载会重新显示"
        className="rounded px-1 py-0.5 text-[10px] text-yellow-700 hover:bg-yellow-500/10 focus-visible:outline-2 focus-visible:outline-yellow-500 disabled:opacity-50 dark:text-yellow-400"
      >
        {clearing ? "清除中…" : "清除警告"}
      </button>
      {error && <span role="alert" className="text-xs text-red-500">{error}</span>}
    </span>
  );
}
