"use client";

import { useEffect, useRef, useState } from "react";
import Modal from "@/shared/components/Modal";
import Button from "@/shared/components/Button";
import { clock, duration, formatNumber, throughput, tokenCount, Icon } from "./format";
import { getOutputThroughput } from "@/shared/utils/outputThroughput.js";
import { isReportedOverload } from "@/shared/utils/diagnosticStatistics";
import { isSlowResponse } from "@/shared/utils/requestDiagnostics";
import AccountQualityBadge from "@/shared/components/AccountQualityBadge";
import AccountPlanBadge from "@/shared/components/AccountPlanBadge";

export default function DiagnosticsDetailsModal({ isOpen, onClose, data, loading, error, selection, focusName, issue, onIssueChange, onPageChange, slowMs }) {
  const [expanded, setExpanded] = useState(null);
  const dialogRef = useRef(null);
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.querySelector("button")?.focus();
    const trapFocus = event => {
      if (event.key !== "Tab") return;
      const buttons = [...dialog.querySelectorAll('button:not(:disabled), [href], input, select, [tabindex="0"]')];
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    dialog?.addEventListener("keydown", trapFocus);
    return () => { dialog?.removeEventListener("keydown", trapFocus); previous?.focus(); };
  }, [isOpen]);
  return <div ref={dialogRef} role={isOpen ? "dialog" : undefined} aria-modal={isOpen ? "true" : undefined} aria-label="请求明细" data-i18n-skip>
    <Modal isOpen={isOpen} onClose={onClose} title="请求明细" size="full" footer={<Button variant="outline" onClick={onClose}>关闭</Button>}>
      <p className="mb-3 break-all text-sm text-text-muted">{[focusName, selection?.name].filter(Boolean).join(" · ") || "全部账号与 API Key"}<span className="ml-2 text-xs">{data ? `${formatNumber(data.pagination.total)} 条` : ""}</span></p>
      <div className="mb-4 flex flex-wrap gap-1" aria-label="明细状态筛选">{[{ value: "all", label: "全部" }, { value: "error", label: "失败尝试" }, { value: "overload", label: "过载报告" }, { value: "slow", label: "长响应" }, { value: "success", label: "成功" }, { value: "cancelled", label: "已取消" }].map(item => <button key={item.value} type="button" aria-pressed={issue === item.value} onClick={() => onIssueChange(item.value)} className={`min-h-10 cursor-pointer rounded-lg px-3 text-xs font-medium transition-colors ${issue === item.value ? "bg-primary/10 text-primary" : "text-text-muted hover:bg-surface-2"}`}>{item.label}</button>)}</div>
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
      {loading && <p role="status" className="mb-3 text-xs text-text-muted">正在加载请求记录…</p>}
      {data && <>
        <div className={`overflow-x-auto ${loading ? "opacity-50" : ""}`} aria-busy={loading}>
          <table className="w-full min-w-[800px] text-left text-sm"><caption className="sr-only">所选时间段与调用人的请求日志</caption>
            <thead className="bg-surface-2/60 text-xs text-text-muted"><tr>{["发生时间", "API Key / 实际账号", "模型", "结果", "开始响应 / 总耗时", "原因"].map(label => <th key={label} className="whitespace-nowrap px-5 py-3 font-medium">{label}</th>)}</tr></thead>
            <tbody>{data.details.map(record => <RequestRow key={record.id} record={record} expanded={expanded === record.id} onToggle={() => setExpanded(expanded === record.id ? null : record.id)} slowMs={slowMs} />)}</tbody>
          </table>
          {!data.details.length && <p className="px-6 py-10 text-center text-sm text-text-muted">当前筛选下没有请求记录</p>}
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-4 text-xs text-text-muted"><span>第 {data.pagination.page} / {data.pagination.totalPages} 页 · 每页 20 条</span><div className="flex gap-2"><Button variant="outline" disabled={loading || data.pagination.page <= 1} onClick={() => onPageChange(data.pagination.page - 1)}>上一页</Button><Button variant="outline" disabled={loading || data.pagination.page >= data.pagination.totalPages} onClick={() => onPageChange(data.pagination.page + 1)}>下一页</Button></div></div>
      </>}
    </Modal>
  </div>;
}

function Status({ record }) {
  const style = record.kind === "error" ? record.recovered ? "bg-amber-500/10 text-amber-700 dark:text-amber-300" : "bg-danger/10 text-danger" : record.kind === "cancelled" ? "bg-surface-2 text-text-muted" : "bg-success/10 text-emerald-700 dark:text-emerald-300";
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium ${style}`}>
    <Icon className="text-[14px]">{record.kind === "error" ? record.recovered ? "replay" : "error" : record.kind === "cancelled" ? "block" : "check_circle"}</Icon>
    {record.recovered ? "重试恢复" : record.kind === "error" ? `失败${record.statusCode ? ` ${record.statusCode}` : ""}` : record.kind === "cancelled" ? "已取消" : "成功"}
  </span>;
}
function RequestRow({ record, expanded, onToggle, slowMs }) {
  const slow = isSlowResponse(record, slowMs);
  const overloaded = isReportedOverload(record);
  const rates = getOutputThroughput(record);
  return <>
    <tr className="border-t border-border-subtle hover:bg-surface-2/40">
      <td className="whitespace-nowrap px-5 py-4 font-mono text-xs"><button onClick={onToggle} aria-expanded={expanded} aria-label={`查看 ${clock(record.timestamp)} 的请求详情`} className="flex min-h-9 cursor-pointer items-center gap-1.5 hover:text-primary"><Icon className={`text-[16px] ${expanded ? "rotate-90" : ""}`}>chevron_right</Icon>{clock(record.timestamp)}</button><span className="ml-5 text-[11px] text-text-muted">{new Date(record.timestamp).toLocaleDateString("zh-CN")}</span></td>
      <td className="max-w-64 px-5 py-4"><p className="select-text font-medium">{record.apiKeyName}</p><p className="mt-1 select-text break-all text-xs text-text-muted">{record.accountName}</p><div className="flex flex-wrap items-center gap-x-2"><AccountPlanBadge connection={record} /><AccountQualityBadge connection={record} /></div></td>
      <td className="px-5 py-4"><p className="whitespace-nowrap font-mono text-xs">{record.model}</p><p className="mt-1 text-xs text-text-muted">{record.provider}</p></td>
      <td className="px-5 py-4"><Status record={record} /></td>
      <td className="whitespace-nowrap px-5 py-4 font-mono text-xs"><span className="text-text-muted">{duration(record.ttftMs)}</span><span className="mx-1.5 text-text-muted">/</span><span className={slow ? "text-amber-700 dark:text-amber-300" : ""}>{duration(record.latencyMs)}</span>{slow && <span className="ml-2 rounded bg-warning/10 px-1.5 py-0.5 font-sans text-amber-700 dark:text-amber-300">长响应</span>}</td>
      <td className="max-w-60 px-5 py-4 text-xs leading-5 text-text-muted">{record.kind === "success" ? slow ? "响应耗时偏高" : "—" : overloaded ? "上游明确报告过载" : record.message}</td>
    </tr>
    {expanded && <tr className="border-t border-border-subtle bg-surface-2/40"><td colSpan={6} className="px-7 py-4"><dl className="grid gap-x-8 gap-y-2 text-xs sm:grid-cols-2 xl:grid-cols-3">
      {[["API Key", record.apiKeyName], ["实际账号", record.accountName], ["请求 ID", record.requestId || "未记录"], ["错误来源", ({ upstream: "上游", router: "路由 / 排队", client: "客户端" })[record.source] || record.source], ["客户端 IP", record.clientIp || "未记录"], ["端点", record.endpoint || "未记录"], ["开始响应延迟", duration(record.ttftMs)], ["总耗时", duration(record.latencyMs)], ["全程输出吞吐（含执行内等待）", throughput(rates?.totalTps)], ["非思考全程吞吐", throughput(rates?.nonReasoningTps)], ["输入 token", tokenCount(record.inputTokens)], ["总输出 token", tokenCount(record.outputTokens)], ["思考 token", tokenCount(record.reasoningTokens)], ["重试次数", record.retryCount], ["上游 HTTP 状态", record.upstreamStatus ?? "未记录"], ["本地排队耗时", duration(record.queueWaitMs)], ["过载证据", overloaded ? "上游报告过载 / 并发限制" : "无明确过载报告"]].map(([label, value]) => <div key={label} className="min-w-0"><dt className="mb-1 text-text-muted">{label}</dt><dd className="break-all font-medium text-text-main">{value}</dd></div>)}
    </dl></td></tr>}
  </>;
}
