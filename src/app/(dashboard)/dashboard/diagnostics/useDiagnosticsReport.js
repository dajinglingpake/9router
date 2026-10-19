"use client";

import { useEffect, useState } from "react";

export default function useDiagnosticsReport(options) {
  const requestKey = options ? JSON.stringify(options) : "";
  const [result, setResult] = useState({ key: "", data: null, error: "" });
  useEffect(() => {
    if (!requestKey) return;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(JSON.parse(requestKey))) {
      if (value == null || key === "refreshTick") continue;
      if (key === "start" || key === "end") params.set(key, new Date(value).toISOString());
      else if (key === "includeAnalysis") params.set("analysis", value ? "1" : "0");
      else if (key === "detailsOnly") params.set(key, value ? "1" : "0");
      else params.set(key, String(value));
    }
    const load = async () => {
      const response = await fetch(`/api/usage/diagnostics?${params}`, { cache: "no-store", signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取诊断数据失败");
      if (!controller.signal.aborted) setResult({ key: requestKey, data, error: "" });
    };
    load().catch(error => {
      if (timedOut || !controller.signal.aborted) setResult({ key: requestKey, data: null,
        error: timedOut ? "读取诊断数据超时，请缩短时间范围后重试。" : error.message });
    }).finally(() => clearTimeout(timeout));
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [requestKey]);
  return { data: requestKey ? result.data : null, error: result.key === requestKey ? result.error : "",
    loading: !!requestKey && result.key !== requestKey };
}
