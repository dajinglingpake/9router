"use client";

import { useEffect, useState } from "react";

const empty = { models: [], warning: "", loading: false };

export function useCodexModels(connections, { enabled = true, respectEnabledModels = false } = {}) {
  const key = JSON.stringify(enabled ? connections.filter(connection => connection.provider === "codex" && connection.isActive !== false)
    .map(connection => ({ id: connection.id, name: connection.name || connection.email || connection.id,
      enabledModels: respectEnabledModels ? connection.providerSpecificData?.enabledModels : null })) : []);
  const [state, setState] = useState({ ...empty, key: "[]" });
  useEffect(() => {
    const accounts = JSON.parse(key);
    if (!accounts.length) return;
    const controller = new AbortController();
    Promise.all(accounts.map(async account => {
      try {
        const response = await fetch(`/api/providers/${account.id}/models`, {
          cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "模型查询失败");
        const models = Array.isArray(data.models) ? data.models : [];
        return { ...account, models: Array.isArray(account.enabledModels) && account.enabledModels.length
          ? models.filter(model => account.enabledModels.some(id => [model.id, `cx/${model.id}`, `codex/${model.id}`].includes(id))) : models,
        warning: data.warning };
      } catch { return { ...account, models: [], warning: "模型列表查询失败，请稍后刷新。" }; }
    })).then(results => {
      if (controller.signal.aborted) return;
      const models = new Map();
      for (const account of results) for (const model of account.models) {
        if (!models.has(model.id)) models.set(model.id, { ...model, connectionIds: [] });
        models.get(model.id).connectionIds.push(account.id);
      }
      setState({ key, models: [...models.values()], loading: false,
        warning: results.filter(account => account.warning).map(account => `${account.name}：${account.warning}`).join("；") });
    });
    return () => controller.abort();
  }, [key]);
  return key === "[]" ? empty : state.key === key ? state : { ...empty, loading: true };
}
