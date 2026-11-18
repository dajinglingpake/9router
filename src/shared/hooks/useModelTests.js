"use client";

import { useEffect, useRef, useState } from "react";

const empty = { results: {}, testing: new Set(), batch: null, canTest: false, warning: null };

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

export function useModelTests(provider, scope) {
  const contextRef = useRef(null);
  const [state, setState] = useState(empty);

  useEffect(() => {
    if (!provider) return;
    const context = { scope, testing: new Set(), controller: new AbortController(), stopped: false, running: false, canTest: false };
    contextRef.current = context;
    queueMicrotask(() => {
      if (contextRef.current === context) setState({ ...empty, scope, loading: true });
    });
    async function load() {
      try {
        const response = await fetch(`/api/models/test?provider=${encodeURIComponent(provider)}`, { signal: context.controller.signal, cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "无法读取模型测试记录。");
        if (contextRef.current !== context) return;
        context.canTest = data.canTest === true;
        setState({ ...empty, scope, results: data.results || {}, canTest: context.canTest, warning: data.warning || null });
      } catch (error) {
        if (contextRef.current === context) setState({ ...empty, scope, warning: error.message });
      }
    }
    void load();
    return () => {
      context.stopped = true;
      context.controller.abort();
      contextRef.current = null;
    };
  }, [provider, scope]);

  async function testModel(modelId) {
    const context = contextRef.current;
    if (!context?.canTest || context.scope !== scope || context.testing.has(modelId)) return;
    context.testing.add(modelId);
    setState(previous => ({ ...previous, testing: new Set(context.testing) }));
    let result;
    try {
      const response = await fetch("/api/models/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `${provider}/${modelId}`, kind: "llm" }),
        signal: AbortSignal.any([context.controller.signal, AbortSignal.timeout(25000)]),
      });
      const data = await response.json();
      result = { status: response.ok && data.ok ? "ok" : "error", error: data.error || "", latencyMs: data.latencyMs, testedAt: data.testedAt };
    } catch (error) {
      result = { status: "error", error: error.name === "TimeoutError" ? "检测超时，请重试。" : "模型检测失败，请稍后重试。" };
    } finally {
      context.testing.delete(modelId);
    }
    if (contextRef.current !== context) return;
    setState(previous => ({ ...previous, results: { ...previous.results, [modelId]: result }, testing: new Set(context.testing) }));
  }

  async function testAll(modelIds) {
    const context = contextRef.current;
    if (!modelIds.length || !context?.canTest || context.scope !== scope || context.running || context.testing.size) return;
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

  const current = state.scope === scope ? state : empty;
  return { ...current, testModel, testAll, stop };
}
