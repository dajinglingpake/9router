"use client";

import { useEffect, useRef } from "react";
import { formatTrialOutput } from "@/shared/utils/codexTrialOutput";

export default function CodexTrialOutput({ result, text, now, className = "", title }) {
  const viewport = useRef(null);
  const follow = useRef(true);
  const running = result?.status === "running";
  const age = result?.lastOutputAt ? Math.max(0, Math.floor((now - new Date(result.lastOutputAt).getTime()) / 1000)) : null;
  useEffect(() => {
    if (follow.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [text]);
  return <section aria-label={title || "Codex 执行输出"} className={`flex min-h-0 flex-col overflow-hidden bg-slate-950 text-slate-200 ${className}`}>
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-2.5 text-xs">
      <span className="flex items-center gap-2"><span className={`h-1.5 w-1.5 rounded-full ${running ? "animate-pulse bg-emerald-400 motion-reduce:animate-none" : "bg-slate-500"}`} />{title || (running ? "实时执行输出" : "执行输出")}</span>
      <span className="text-slate-400">{running && age !== null ? `${age} 秒前收到输出` : running ? "等待首条输出" : "已保存"}</span>
    </div>
    <pre ref={viewport} tabIndex={0} aria-label="Codex 输出内容"
      onScroll={event => { const element = event.currentTarget; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32; }}
      className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary">
      {text ? formatTrialOutput(text) : (running ? "CLI 正在启动或等待响应，收到输出后会自动显示。" : "暂无执行输出。")}
    </pre>
    {running && <p className="border-t border-slate-800 px-4 py-2 text-[11px] text-slate-400">{result.activity || "执行中"} · 每秒更新</p>}
  </section>;
}
