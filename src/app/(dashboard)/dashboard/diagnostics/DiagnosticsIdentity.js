"use client";

import { useState } from "react";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { Icon } from "./format";
import AccountQualityBadge from "@/shared/components/AccountQualityBadge";
import AccountPlanBadge from "@/shared/components/AccountPlanBadge";

export default function DiagnosticsIdentity({ name, onFocus, label = "账号", connection }) {
  const { copied, copy } = useCopyToClipboard();
  const [copyError, setCopyError] = useState(false);
  return <div className="min-w-0"><div className="flex min-w-0 flex-wrap items-center gap-x-1">
    <span className="min-w-0 max-w-full cursor-text select-text break-all text-sm font-semibold">{name}</span>
    <AccountPlanBadge connection={connection} />
    <button type="button" aria-label={`复制${label} ${name}`} title={copied ? "已复制" : `复制完整${label}`} onClick={async event => {
      const button = event.currentTarget;
      setCopyError(false);
      const success = await copy(name);
      setCopyError(!success);
      button.focus({ preventScroll: true });
    }} className={`inline-flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${copied ? "text-emerald-700 dark:text-emerald-300" : "text-text-muted hover:text-primary"}`}>
      <Icon className="text-[18px]">{copied ? "check" : "content_copy"}</Icon>
    </button>
    {onFocus && <button type="button" onClick={onFocus} aria-label={`仅关注${label} ${name}`} title={`仅关注此${label}`} className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2 text-xs text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><Icon className="text-[16px]">filter_center_focus</Icon>仅关注</button>}
    <span className="sr-only" role="status">{copied ? `已复制${label} ${name}` : ""}</span>
    {copyError && <span role="alert" className="basis-full text-xs leading-5 text-danger">复制失败，请选中名称手动复制。</span>}
  </div><AccountQualityBadge connection={connection} /></div>;
}
