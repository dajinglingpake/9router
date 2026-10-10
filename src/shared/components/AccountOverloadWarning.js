"use client";

import { useState } from "react";
import Badge from "./Badge";
import Modal from "./Modal";
import Button from "./Button";

export default function AccountOverloadWarning({ connection, onUpdated }) {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [details, setDetails] = useState(null);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState("");
  const warning = connection.overloadWarning;
  if (!warning) return null;
  const url = `/api/providers/${encodeURIComponent(connection.id)}/overload-warning`;

  const loadDetails = async () => {
    setIsOpen(true);
    setLoading(true);
    setDetails(null);
    setError("");
    try {
      const response = await fetch(url, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error("Unable to load details");
      setDetails(data);
      onUpdated(data.overloadWarning);
    } catch {
      setError("详情加载失败，请重试");
    } finally {
      setLoading(false);
    }
  };

  const clear = async () => {
    setClearing(true);
    setError("");
    try {
      const response = await fetch(url, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: details.overloadWarning.eventId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error("Unable to clear warning");
      onUpdated(data.overloadWarning);
      if (data.overloadWarning) {
        await loadDetails();
        setError("期间有新的过载记录，已刷新详情，请再次清除");
      } else {
        setIsOpen(false);
      }
    } catch {
      setError("清除失败，请重试");
    } finally {
      setClearing(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={loadDetails}
        data-account-overload-warning={connection.id}
        aria-label={`查看 ${warning.count} 次过载详情`}
        title="查看过载详情；该账号自动选取时排在无过载记录账号之后"
        className="mt-1 rounded-full hover:bg-yellow-500/10 focus-visible:outline-2 focus-visible:outline-yellow-500"
      >
        <Badge variant="warning" size="sm" icon="warning">过载 {warning.count} 次</Badge>
      </button>
      <Modal isOpen={isOpen} onClose={() => setIsOpen(false)} title="账号过载详情" size="xl" footer={
        <>
          <Button variant="ghost" onClick={() => setIsOpen(false)} disabled={clearing}>关闭</Button>
          <Button variant="secondary" onClick={clear} loading={clearing} disabled={loading || !details?.overloadWarning} aria-label="清除过载警告">清除记录</Button>
        </>
      }>
        <div className="space-y-4 text-sm">
          <p className="break-all font-medium">{connection.name || connection.email || connection.id}</p>
          <p className="text-text-muted">上次清除后记录到上游过载或暂不可用（503）{details?.overloadWarning?.count ?? warning.count} 次。自动选择时优先使用没有过载记录的可用账号。</p>
          <p className="text-xs text-text-muted">清除会重置计数并恢复正常排序，保留历史日志和当前冷却状态。</p>
          {loading && <p role="status">正在加载详情…</p>}
          {error && <div role="alert" className="text-red-500">{error}{!details && <Button variant="ghost" size="sm" onClick={loadDetails}>重试</Button>}</div>}
          {details && (
            <>
              <p className="text-xs text-text-muted">最近一次：{new Date(details.overloadWarning?.lastAt ?? warning.lastAt).toLocaleString()}</p>
              {details.hasMore && <p className="text-xs text-text-muted">仅展示最近 50 条，累计次数包含更早的记录。</p>}
              {!details.hasMore && details.items.length < (details.overloadWarning?.count || 0) && <p className="text-xs text-text-muted">部分早期记录或已清理日志仅保留计数和最近发生时间。</p>}
              <ul className="space-y-3">
                {details.items.map(item => (
                  <li key={item.id} className="rounded-lg border border-border-subtle p-3 space-y-1">
                    <div className="flex flex-wrap justify-between gap-2 text-xs text-text-muted">
                      <time>{new Date(item.timestamp).toLocaleString()}</time>
                      <span>{item.model || "未记录模型"}{item.recovered ? " · 请求已恢复" : ""}</span>
                    </div>
                    <p className="text-xs text-text-muted">{item.upstreamStatus === 200 ? "上游流式响应中返回过载错误（映射为 503）" : "上游返回 503"}</p>
                    <p className="whitespace-pre-wrap break-words text-text-main">{item.message || "上游暂不可用"}</p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
