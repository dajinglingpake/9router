"use client";

import { useEffect, useState } from "react";

export default function AccountApiKeyBindingSelect({ value, onChange, disabled }) {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/keys", { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("API Key 列表加载失败，请重新打开编辑窗口。");
        const data = await response.json();
        setKeys((data.keys || []).map(key => ({ id: key.id, name: key.name, isActive: key.isActive })));
      })
      .catch(err => {
        if (!controller.signal.aborted) setError(err.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const options = [];
  for (const key of keys) {
    if (key.isActive || value.includes(key.id)) {
      options.push({ value: key.id, label: `${key.name || key.id}${key.isActive ? "" : "（已停用）"}` });
    }
  }
  for (const id of value.filter(id => !keys.some(key => key.id === id))) {
    options.push({ value: id, label: `已绑定 API Key（${id.slice(0, 8)}）` });
  }

  return (
    <fieldset disabled={disabled || loading || !!error} className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium text-text-main">专用 API Key（可多选）</legend>
      <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border border-border p-3">
        {options.map(option => (
          <label key={option.value} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={value.includes(option.value)}
              onChange={event => onChange(event.target.checked
                ? [...value, option.value] : value.filter(id => id !== option.value))} />
            <span className="break-all">{option.label}</span>
          </label>
        ))}
        {!options.length && <p className="text-xs text-text-muted">{loading ? "正在加载 API Key…" : "暂无可绑定的 API Key"}</p>}
      </div>
      {value.length > 0 && <button type="button" className="self-start text-xs text-primary disabled:opacity-50" onClick={() => onChange([])}>清空绑定（恢复共享）</button>}
      {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
      <p className="text-xs text-text-muted">选中的 Key 在此提供商下始终使用此账号，其他 Key 无法使用。过载或停用时不换号；不选择则为共享账号。</p>
      <p className="text-xs text-text-muted">账号禁用时也可配置，保持禁用直到手动开启。</p>
    </fieldset>
  );
}
