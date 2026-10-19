"use client";

import Button from "@/shared/components/Button";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { CODEX_TRIAL_MODELS } from "@/shared/utils/codexTrial";

const labels = { low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高" };
const control = "mt-1.5 min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text-main outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50";
const defaultEffort = model => {
  const levels = getThinkingLevels("codex", model) || [];
  return levels.includes("xhigh") ? "xhigh" : levels.at(-1);
};

export default function CodexTrialModels({ models, onChange, disabled }) {
  const remaining = CODEX_TRIAL_MODELS.find(item => !models.some(selected => selected.model === item.id));
  const update = (index, value) => onChange(models.map((item, i) => i === index ? value : item));
  return <div className="mt-4 space-y-3">
    {models.map((item, index) => <div key={index} className="grid items-end gap-3 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_auto]">
      <label className="min-w-0 text-xs text-text-muted">模型 {index + 1}
        <select aria-label={`模型 ${index + 1}`} className={control} value={item.model} disabled={disabled}
          onChange={event => update(index, { model: event.target.value, effort: defaultEffort(event.target.value) })}>
          {CODEX_TRIAL_MODELS.map(model => <option key={model.id} value={model.id}
            disabled={models.some((selected, i) => i !== index && selected.model === model.id)}>{model.id}</option>)}
        </select>
      </label>
      <label className="text-xs text-text-muted">推理强度
        <select aria-label={`模型 ${index + 1} 的推理强度`} className={control} value={item.effort} disabled={disabled}
          onChange={event => update(index, { ...item, effort: event.target.value })}>
          {(getThinkingLevels("codex", item.model) || []).map(level => <option key={level} value={level}>{labels[level] || level} · {level}</option>)}
        </select>
      </label>
      <Button variant="ghost" disabled={disabled || models.length === 1} aria-label={`移除模型 ${index + 1}`}
        onClick={() => onChange(models.filter((_, i) => i !== index))}>移除</Button>
    </div>)}
    <Button variant="secondary" size="sm" icon="add" disabled={disabled || !remaining}
      onClick={() => onChange([...models, { model: remaining.id, effort: defaultEffort(remaining.id) }])}>添加模型</Button>
  </div>;
}
