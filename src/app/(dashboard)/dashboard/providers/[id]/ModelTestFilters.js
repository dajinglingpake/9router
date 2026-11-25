"use client";

import { Toggle } from "@/shared/components";
import { FREE_MODEL_FILTER_PROVIDERS } from "@/shared/utils/modelTests";

export default function ModelTestFilters({ provider, tests, statusFilter, onStatusChange }) {
  const { preferences, savingPreferences, savePreferences, batch } = tests;
  const disabled = !preferences || savingPreferences;
  const isGemini = provider === "gemini";
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 py-1">
      <Toggle
        label={isGemini ? "隐藏检测失败的模型（含对外 API）" : "对外隐藏检测失败的模型"}
        checked={preferences?.hideFailedModels === true}
        onChange={checked => savePreferences({ hideFailedModels: checked })}
        disabled={disabled}
      />
      {FREE_MODEL_FILTER_PROVIDERS.includes(provider) && <Toggle
        label="只显示免费模型"
        description="同时筛选此页和对外 API 的模型列表"
        checked={preferences?.freeOnly === true}
        onChange={checked => savePreferences({ freeOnly: checked })}
        disabled={disabled || batch?.running}
      />}
      {isGemini && <select aria-label="按检测状态筛选模型" value={statusFilter} onChange={e => onStatusChange(e.target.value)}
        className="rounded-md border border-border bg-background px-2 py-1 text-xs focus:border-primary focus:outline-none">
        <option value="all">全部状态</option>
        <option value="ok">可用</option>
        <option value="retry">待重试</option>
        {!preferences?.hideFailedModels && <option value="error">检测失败</option>}
        <option value="untested">未检测</option>
      </select>}
    </div>
  );
}
