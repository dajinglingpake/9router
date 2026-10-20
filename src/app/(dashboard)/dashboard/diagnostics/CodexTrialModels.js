"use client";

import Button from "@/shared/components/Button";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";

const labels = { low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高" };
const control = "mt-1.5 min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text-main outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50";
export const trialDefaultEffort = (provider, model) =>
  provider === "codex" && getThinkingLevels(provider, model)?.includes("xhigh") ? "xhigh" : "";

export default function CodexTrialModels({ provider, models, onChange, disabled }) {
  if (!provider) return null;
  const remaining = provider.models.find(item => !models.some(selected => selected.model === item.id));
  const update = (index, value) => onChange(models.map((item, i) => i === index ? value : item));
  const chooseModel = (index, model) => update(index, { model, effort: trialDefaultEffort(provider.id, model) });
  return <div className="mt-4 space-y-3">
    <datalist id="account-trial-models">{provider.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</datalist>
    {models.map((item, index) => <div key={index} className="grid items-end gap-3 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_auto]">
      <label className="min-w-0 text-xs text-text-muted">模型 {index + 1}
        {provider.allowCustomModel ? <input aria-label={`模型 ${index + 1}`} list="account-trial-models" className={control}
          value={item.model} disabled={disabled} placeholder="选择或输入上游模型 ID"
          onChange={event => chooseModel(index, event.target.value)} />
          : <select aria-label={`模型 ${index + 1}`} className={control} value={item.model} disabled={disabled}
          onChange={event => chooseModel(index, event.target.value)}>
          {provider.models.map(model => <option key={model.id} value={model.id}
            disabled={models.some((selected, i) => i !== index && selected.model === model.id)}>{model.id}</option>)}
        </select>}
      </label>
      <label className="text-xs text-text-muted">推理强度
        <select aria-label={`模型 ${index + 1} 的推理强度`} className={control} value={item.effort || ""} disabled={disabled || !getThinkingLevels(provider.id, item.model)?.length}
          onChange={event => update(index, { ...item, effort: event.target.value })}>
          <option value="">模型默认</option>
          {(getThinkingLevels(provider.id, item.model) || []).map(level => <option key={level} value={level}>{labels[level] || level} · {level}</option>)}
        </select>
      </label>
      <Button variant="ghost" disabled={disabled || models.length === 1} aria-label={`移除模型 ${index + 1}`}
        onClick={() => onChange(models.filter((_, i) => i !== index))}>移除</Button>
    </div>)}
    <Button variant="secondary" size="sm" icon="add" disabled={disabled || models.length >= 20 || (!remaining && !provider.allowCustomModel)}
      onClick={() => onChange([...models, { model: remaining?.id || "", effort: trialDefaultEffort(provider.id, remaining?.id) }])}>添加模型</Button>
  </div>;
}
