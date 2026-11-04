"use client";

import { useState } from "react";
import Modal from "./Modal";

export default function CodexSessionDownloadButton({ connection, iconOnly = false, disabled = false }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (connection.provider !== "codex" || !["oauth", "access_token"].includes(connection.authType)) return null;

  const download = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/providers/${encodeURIComponent(connection.id)}/session-export`, {
        cache: "no-store", signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) { const result = await response.json(); throw new Error(result.error || "Session 下载失败，请稍后重试。"); }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] || "session.txt";
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setError(error.name === "TimeoutError" ? "下载超时，请稍后重试。" : error.message || "Session 下载失败，请稍后重试。");
    } finally { setBusy(false); }
  };

  return <>
    <button type="button" onClick={download} disabled={disabled || busy} aria-busy={busy}
      aria-label="下载 Session" title="下载账号 Session（TXT）"
      className={`${iconOnly ? "flex h-8 w-8 items-center justify-center" : "flex w-full flex-col items-center px-2 py-1"} rounded-lg text-text-muted transition-colors hover:bg-black/5 hover:text-primary disabled:opacity-50 dark:hover:bg-white/5`}>
      <span className={`material-symbols-outlined text-[18px] ${busy ? "animate-spin" : ""}`}>{busy ? "progress_activity" : "download"}</span>
      {!iconOnly && <span className="text-[10px] leading-tight">下载 Session</span>}
    </button>
    <Modal isOpen={!!error} onClose={() => setError("")} title="Session 下载失败">
      <p role="alert" className="text-sm">{error}</p>
    </Modal>
  </>;
}
