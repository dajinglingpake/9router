"use client";

import { useState } from "react";
import Modal from "./Modal";
import Button from "./Button";
import { CODEX_SESSIONS_CONFIG } from "open-sse/providers/registry/codex.js";

export default function CodexLogoutAllButton({ connection, onSuccess, iconOnly = false, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  if (connection.provider !== "codex" || !["oauth", "access_token"].includes(connection.authType)) return null;
  const close = () => { if (!busy) setOpen(false); };
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/providers/${connection.id}/logout-all`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }),
      });
      const data = await response.json();
      if (!response.ok || data.logoutRequested !== true) throw new Error(data.error || "无法确认退出结果，请稍后重试。");
      setResult(data);
      await onSuccess?.();
    } catch (error) {
      setError(error.message || "退出请求失败，请稍后重试。");
    } finally { setBusy(false); }
  };
  return <>
    <button type="button" onClick={() => { setError(""); setResult(null); setOpen(true); }}
      disabled={disabled || busy || connection.testStatus === "logged_out"}
      aria-label="退出所有设备" title="退出此 OpenAI 账号的所有设备，保留账号记录"
      className={`${iconOnly ? "flex h-8 w-8 items-center justify-center" : "flex w-full flex-col items-center px-2 py-1"} rounded-lg text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50`}>
      <span className="material-symbols-outlined text-[18px]">logout</span>
      {!iconOnly && <span className="text-[10px] leading-tight">退出所有设备</span>}
    </button>
    <Modal isOpen={open} onClose={close} closeOnOverlay={!busy} title={result ? "退出请求已提交" : "退出所有设备？"}
      footer={<><Button variant="ghost" onClick={close} disabled={busy}>{result ? "完成" : "取消"}</Button>
        {!result && <Button onClick={submit} disabled={busy} className="bg-red-600 hover:bg-red-700 text-white">{busy ? "正在提交…" : "确认退出所有设备"}</Button>}</>}>
      <div className="space-y-3 text-sm">
        <p className="break-all font-medium">{connection.email || connection.name}</p>
        {result ? <>
          <p role="status">OpenAI 已受理退出请求，其他设备最多可能需要 30 分钟生效。</p>
          <p>{result.localUpdated ? "账号记录和配置已保留，本地凭证已清除。请点击原账号的“重新登录”，成功后恢复退出前的启用状态。" : result.warning}</p>
        </> : <>
          <p>这会按 ChatGPT 网页端的范围退出该账号在各设备上的登录。</p>
          <p>账号记录、代理、专用密钥和其他配置会保留。本地账号会暂停使用并清除旧凭证，重新登录成功后恢复原来的启用状态。</p>
          <p className="text-text-muted">其他设备最多可能需要 30 分钟生效。退出后重新登录会自动带入该账号邮箱。</p>
        </>}
        {error && <p role="alert" className="text-red-500 break-words">{error}</p>}
        {(error || result?.warning) && <a href={CODEX_SESSIONS_CONFIG.settingsUrl} target="_blank" rel="noopener noreferrer" className="inline-block text-primary underline">打开 ChatGPT 会话安全设置</a>}
      </div>
    </Modal>
  </>;
}
