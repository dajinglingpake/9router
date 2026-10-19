"use client";

import { useEffect, useState } from "react";
import DiagnosticsDetailsModal from "./DiagnosticsDetailsModal";

// Read only this trial's details; keep the full dashboard report out of the modal.
export default function CodexTrialErrors({ account, onClose }) {
  const [issue, setIssue] = useState("error");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState({ key: "", data: null, error: "" });
  const key = JSON.stringify({ id: account.result.id, runId: account.result.runId, end: account.result.finishedAt, issue, page });
  useEffect(() => {
    const controller = new AbortController();
    const query = JSON.parse(key);
    let timer;
    const load = async () => {
      try {
        const params = new URLSearchParams({ issue: query.issue, page: String(query.page) });
        const response = await fetch(`/api/codex-trials/${encodeURIComponent(query.id)}/errors?${params}`,
          { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "读取中转错误失败。");
        if (!controller.signal.aborted) setResult({ key, data, error: "" });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ key, data: null, error: error.name === "TimeoutError" ? "读取中转错误超时，请关闭后重试。" : error.message });
      } finally {
        if (!query.end && !controller.signal.aborted) timer = setTimeout(load, 3000);
      }
    };
    load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [key]);
  return <DiagnosticsDetailsModal isOpen blurBackdrop={false} onClose={onClose} data={result.key === key ? result.data : null}
    loading={result.key !== key} error={result.key === key ? result.error : ""}
    focusName={`${account.name} · 本次测试时段`} issue={issue} slowMs={60000}
    onIssueChange={value => { setIssue(value); setPage(1); }} onPageChange={setPage} />;
}
