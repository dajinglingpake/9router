"use client";

import { useEffect, useRef, useState } from "react";
import Modal from "./Modal";
import Button from "./Button";
import { CODEX_SESSIONS_CONFIG } from "open-sse/providers/registry/codex.js";
import { getCodexDeviceStatus } from "@/shared/utils/codexSessions";

const time = value => {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "未记录";
};

export default function CodexSessionsButton({ connection, iconOnly = false, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [record, setData] = useState(null);
  const [error, setError] = useState("");
  const controller = useRef(null);
  useEffect(() => () => controller.current?.abort(), []);
  if (connection.provider !== "codex" || !["oauth", "access_token"].includes(connection.authType)) return null;
  const data = record?.connectionId === connection.id && !loading && !error ? record : null;
  const close = () => { controller.current?.abort(); setOpen(false); setLoading(false); setData(null); };
  const load = async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setData(null);
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/providers/${connection.id}/sessions`, {
        cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(25000)]),
      });
      const result = await response.json();
      if (!response.ok || result.verified === false) throw new Error(result.error || result.warning || "设备列表读取失败。");
      if (result.connectionId !== connection.id || result.source !== "openai" || result.verified !== true || !Array.isArray(result.devices)) {
        throw new Error("设备列表响应无效，请稍后刷新。");
      }
      if (!request.signal.aborted) setData(result);
    } catch (error) {
      if (!request.signal.aborted) setError(error.message || "设备列表读取失败，请稍后刷新。");
    } finally { if (!request.signal.aborted) setLoading(false); }
  };
  const devices = data?.devices || [];
  return <>
    <button type="button" onClick={() => { setOpen(true); void load(); }} disabled={disabled}
      aria-label="查看登录设备" title="从 OpenAI 接口获取本次设备列表"
      className={`${iconOnly ? "flex h-8 w-8 items-center justify-center" : "flex w-full flex-col items-center px-2 py-1"} rounded-lg text-text-muted transition-colors hover:bg-black/5 hover:text-primary disabled:opacity-50 dark:hover:bg-white/5`}>
      <span className="material-symbols-outlined text-[18px]">devices</span>
      {!iconOnly && <span className="text-[10px] leading-tight">登录设备</span>}
    </button>
    <Modal isOpen={open} onClose={close} title="OpenAI 设备会话" size="lg"
      footer={<><Button variant="ghost" onClick={close}>关闭</Button><Button onClick={load} disabled={loading}>{loading ? "正在查询…" : "刷新设备列表"}</Button></>}>
      <div className="space-y-4 text-sm">
        <p className="break-all font-medium">{connection.email || connection.name}</p>
        <p className="text-text-muted">数据来源：OpenAI 会话接口。仅显示本次接口返回的设备。</p>
        {loading && <p role="status" className="text-text-muted">正在向 OpenAI 核实设备列表…</p>}
        {error && <div role="status" className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <p>{error}</p><p className="font-medium">本次读取失败，未展示设备列表，无法核实是否已退出所有设备。</p>
          <a href={CODEX_SESSIONS_CONFIG.settingsUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline">打开 ChatGPT 会话安全设置</a>
          <p className="text-xs text-text-muted">打开后请确认网页登录的是上方邮箱。</p>
        </div>}
        {data && <div className="space-y-1">
          <p role="status">OpenAI 本次返回 {devices.length} 个设备。</p>
          <p className="text-xs text-text-muted">本次读取时间：{time(data.checkedAt)}（北京时间）</p>
          {!devices.length && <p className="text-text-muted">OpenAI 本次未返回设备。</p>}
        </div>}
        {devices.length > 0 && <ul className="space-y-3" aria-label="OpenAI 本次返回的设备列表">
          {devices.map(device => <li key={device.id} className="space-y-2 rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="break-words font-medium">{device.name}{device.platform ? ` · ${device.platform}` : ""}</span>
              <span className="rounded bg-sidebar px-2 py-1 text-xs">{getCodexDeviceStatus(device)}</span>
            </div>
            {device.isCurrentSession && <p className="text-xs text-primary">当前会话（OpenAI 标记）</p>}
            {device.apps.length > 0 && <p className="break-words text-xs">应用：{device.apps.join("、")}</p>}
            {device.location && <p className="break-words text-xs">大致位置：{device.location}</p>}
            <div className="space-y-1 text-xs text-text-muted">
              <p>{device.status === "signed_out" ? "OpenAI 最近见到此设备" : "OpenAI 登录时间"}：{time(device.signedInAt)}</p>
            </div>
          </li>)}
        </ul>}
        <p className="text-xs text-text-muted">设备范围以 OpenAI 接口返回为准。列表为空也不能单独证明所有设备均已退出。</p>
      </div>
    </Modal>
  </>;
}
