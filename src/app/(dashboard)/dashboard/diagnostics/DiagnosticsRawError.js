"use client";

import { useState } from "react";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { Icon } from "./format";

export default function DiagnosticsRawError({ message }) {
  const { copied, copy } = useCopyToClipboard();
  const [failed, setFailed] = useState(false);
  let formatted = message;
  try { formatted = JSON.stringify(JSON.parse(message), null, 2); } catch { /* Keep non-JSON errors as recorded. */ }
  return <div className="mb-4 rounded-lg border border-border bg-surface p-3">
    <div className="mb-2 flex items-center justify-between gap-3 text-xs">
      <h3 className="font-semibold">原始错误（日志原文）</h3>
      {message && <button type="button" onClick={async () => setFailed(!await copy(message))} className="inline-flex min-h-9 cursor-pointer items-center gap-1 rounded px-2 text-primary hover:bg-primary/10">
        <Icon className="text-[16px]">{copied ? "check" : "content_copy"}</Icon>{copied ? "已复制" : "复制原始错误"}
      </button>}
    </div>
    {message ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-5 text-text-main">{formatted}</pre>
      : <p className="text-xs text-text-muted">该记录未保存原始错误。</p>}
    {failed && <p role="alert" className="mt-2 text-xs text-danger">复制失败，请选中原文手动复制。</p>}
  </div>;
}
