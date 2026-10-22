"use client";

import Button from "@/shared/components/Button";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";

const labels = { low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高" };
const control = "mt-1.5 min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text-main outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50";
export const trialDefaultEffort = (provider, model, efforts = getThinkingLevels(provider, model)) =>
  provider === "codex" && efforts?.includes("xhigh") ? "xhigh" : "";

export default function CodexTrialModels({ providers, models, onChange, disabled }) {
  const unusedModel = provider => provider.models.find(item => !models.some(selected => selected.provider === provider.id && selected.model === item.id));
  const lastProvider = providers.find(provider => provider.id === models.at(-1)?.provider);
  const nextProvider = lastProvider && (unusedModel(lastProvider) || lastProvider.allowCustomModel) ? lastProvider
    : providers.find(provider => unusedModel(provider) || provider.allowCustomModel);
  const selection = (provider, model = unusedModel(provider)?.id || provider.defaultModel) =>
    ({ provider: provider.id, model, effort: trialDefaultEffort(provider.id, model, provider.models.find(item => item.id === model)?.efforts) });
  const update = (index, value) => onChange(models.map((item, i) => i === index ? value : item));
  return <div className="mt-4 space-y-3">
    {models.map((item, index) => {
      const provider = providers.find(provider => provider.id === item.provider);
      if (!provider) return null;
      const efforts = provider.models.find(model => model.id === item.model)?.efforts || getThinkingLevels(provider.id, item.model) || [];
      return <div key={index} className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1fr)_auto]">
      <label className="min-w-0 text-xs text-text-muted">供应商 {index + 1}
        <select aria-label={`供应商 ${index + 1}`} className={control} value={provider.id} disabled={disabled}
          onChange={event => update(index, selection(providers.find(provider => provider.id === event.target.value)))}>
          {providers.map(provider => <option key={provider.id} value={provider.id}
            disabled={provider.id !== item.provider && !unusedModel(provider) && !provider.allowCustomModel}>{provider.name}</option>)}
        </select>
      </label>
      <label className="min-w-0 text-xs text-text-muted">模型 {index + 1}
        {provider.allowCustomModel ? <><datalist id={`account-trial-models-${index}`}>{provider.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</datalist>
          <input aria-label={`模型 ${index + 1}`} list={`account-trial-models-${index}`} className={control}
          value={item.model} disabled={disabled} placeholder="选择或输入上游模型 ID"
          onChange={event => update(index, selection(provider, event.target.value))} /></>
          : <select aria-label={`模型 ${index + 1}`} className={control} value={item.model} disabled={disabled}
          onChange={event => update(index, selection(provider, event.target.value))}>
          {provider.models.map(model => <option key={model.id} value={model.id}
            disabled={models.some((selected, i) => i !== index && selected.provider === provider.id && selected.model === model.id)}>{model.id}</option>)}
        </select>}
      </label>
      <label className="text-xs text-text-muted">推理强度
        <select aria-label={`模型 ${index + 1} 的推理强度`} className={control} value={item.effort || ""} disabled={disabled || !efforts.length}
          onChange={event => update(index, { ...item, effort: event.target.value })}>
          <option value="">模型默认</option>
          {efforts.map(level => <option key={level} value={level}>{labels[level] || level} · {level}</option>)}
        </select>
      </label>
      <Button variant="ghost" disabled={disabled || models.length === 1} aria-label={`移除模型 ${index + 1}`}
        onClick={() => onChange(models.filter((_, i) => i !== index))}>移除</Button>
    </div>; })}
    {providers.filter(provider => provider.warning).map(provider => <p key={provider.id} role="status" className="text-xs text-amber-700 dark:text-amber-300">{provider.name}：{provider.warning}</p>)}
    <Button variant="secondary" size="sm" icon="add" disabled={disabled || models.length >= 20 || !nextProvider}
      onClick={() => onChange([...models, selection(nextProvider, unusedModel(nextProvider)?.id || "")])}>添加模型</Button>
  </div>;
}
