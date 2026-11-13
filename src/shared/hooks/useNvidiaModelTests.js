"use client";

import { useEffect, useRef, useState } from "react";

const RESULT_TTL_MS = 60 * 60 * 1000;
const STORAGE_PREFIX = "9router:nvidia-model-tests:";

export function readModelTestResults(storage, scope, now = Date.now()) {
  try {
    const results = JSON.parse(storage.getItem(STORAGE_PREFIX + scope) || "{}");
    return Object.fromEntries(Object.entries(results).filter(([, result]) =>
      (result?.status === "ok" || result?.status === "error")
      && Number.isFinite(result.testedAt) && result.testedAt <= now
      && now - result.testedAt < RESULT_TTL_MS));
  } catch { return {}; }
}

// Stop scheduling new probes on cancellation; let in-flight probes finish so
// their results remain usable. Two workers avoid flooding the provider.
export async function runModelTestBatch(modelIds, testModel, stopped, onProgress) {
  let next = 0;
  let completed = 0;
  await Promise.all(Array.from({ length: Math.min(2, modelIds.length) }, async () => {
    while (!stopped() && next < modelIds.length) {
      await testModel(modelIds[next++]);
      onProgress(++completed);
    }
  }));
}

export function useNvidiaModelTests(scope) {
  const contextRef = useRef(null);
  const [state, setState] = useState({ scope: "", results: {}, testing: new Set(), batch: null });

  useEffect(() => {
    const context = { scope, results: {}, testing: new Set(), controller: new AbortController(), stopped: false, running: false };
    try { if (scope) context.results = readModelTestResults(window.localStorage, scope); } catch {}
    contextRef.current = context;
    queueMicrotask(() => {
      if (contextRef.current === context) setState({ scope, results: context.results, testing: new Set(), batch: null });
    });
    return () => {
      context.stopped = true;
      context.controller.abort();
      contextRef.current = null;
    };
  }, [scope]);

  async function testModel(modelId) {
    const context = contextRef.current;
    if (!scope || context?.scope !== scope || context.testing.has(modelId)) return;
    context.testing.add(modelId);
    setState(previous => ({ ...previous, testing: new Set(context.testing) }));
    let result;
    try {
      const response = await fetch("/api/models/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `nvidia/${modelId}`, kind: "llm" }),
        signal: AbortSignal.any([context.controller.signal, AbortSignal.timeout(25000)]),
      });
      const data = await response.json();
      result = { status: response.ok && data.ok ? "ok" : "error", error: data.error || "", latencyMs: data.latencyMs, testedAt: Date.now() };
    } catch (error) {
      result = { status: "error", error: error.name === "TimeoutError" ? "检测超时，请重试。" : "模型检测失败，请稍后重试。", testedAt: Date.now() };
    } finally {
      context.testing.delete(modelId);
    }
    if (contextRef.current !== context) return;
    context.results = { ...context.results, [modelId]: result };
    try { window.localStorage.setItem(STORAGE_PREFIX + scope, JSON.stringify(context.results)); } catch {}
    setState(previous => ({ ...previous, results: context.results, testing: new Set(context.testing) }));
  }

  async function testAll(modelIds) {
    const context = contextRef.current;
    if (!modelIds.length || !scope || context?.scope !== scope || context.running || context.testing.size) return;
    context.running = true;
    context.stopped = false;
    setState(previous => ({ ...previous, batch: { completed: 0, total: modelIds.length, running: true, stopping: false } }));
    await runModelTestBatch(modelIds, testModel, () => context.stopped, completed => {
      if (contextRef.current === context) setState(previous => ({ ...previous, batch: { ...previous.batch, completed } }));
    });
    context.running = false;
    if (contextRef.current === context) setState(previous => ({ ...previous, batch: { ...previous.batch, running: false } }));
  }

  function stop() {
    const context = contextRef.current;
    if (!context?.running) return;
    context.stopped = true;
    setState(previous => ({ ...previous, batch: { ...previous.batch, stopping: true } }));
  }

  const current = state.scope === scope ? state : { results: {}, testing: new Set(), batch: null };
  return { ...current, testModel, testAll, stop };
}
