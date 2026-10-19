"use client";

import { useEffect, useState } from "react";
import DiagnosticsDetailsModal from "./DiagnosticsDetailsModal";

// Reuse request diagnostics, scoped to the account and this trial's time window.
export default function CodexTrialErrors({ account, onClose }) {
  const [issue, setIssue] = useState("error");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState({ key: "", data: null, error: "" });
  const key = JSON.stringify({ id: account.id, start: account.result.startedAt || account.result.queuedAt,
    end: account.result.finishedAt, model: account.result.model, issue, page });
  useEffect(() => {
    const controller = new AbortController();
    const query = JSON.parse(key);
    let timer;
    const load = async () => {
      try {
        const params = new URLSearchParams({
          start: query.start, end: new Date(query.end ? Date.parse(query.end) + 1000 : Date.now() + 1000).toISOString(),
          provider: "codex", model: query.model, focusConnectionId: query.id, issue: query.issue, page: String(query.page),
        });
        const response = await fetch(`/api/usage/diagnostics?${params}`, { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "读取中转错误失败。");
        if (!controller.signal.aborted) setResult({ key, data, error: "" });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ key, data: null, error: error.message });
      } finally {
        if (!query.end && !controller.signal.aborted) timer = setTimeout(load, 3000);
      }
    };
    load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [key]);
  return <DiagnosticsDetailsModal isOpen onClose={onClose} data={result.key === key ? result.data : null}
    loading={result.key !== key} error={result.key === key ? result.error : ""}
    focusName={`${account.name} · 本次测试时段`} issue={issue} slowMs={60000}
    onIssueChange={value => { setIssue(value); setPage(1); }} onPageChange={setPage} />;
}
