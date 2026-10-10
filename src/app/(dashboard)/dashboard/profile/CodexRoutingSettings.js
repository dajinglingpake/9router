"use client";

import { useEffect, useState } from "react";
import { Card, Input, Button, Toggle, Select } from "@/shared/components";
import { CODEX_ROUTING_DEFAULTS } from "@/sse/local/routingPolicy.js";

export default function CodexRoutingSettings() {
  const [config, setConfig] = useState({ ...CODEX_ROUTING_DEFAULTS });
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    fetch("/api/settings/codex-routing", { cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error("读取账号路由配置失败，请刷新页面重试");
      const result = await response.json();
      if (active) { setConfig(result.config); setModels(result.models); setLoading(false); }
    }).catch(error => { if (active) setMessage(error.message); });
    return () => { active = false; };
  }, []);

  const save = async () => {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/settings/codex-routing", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "保存失败");
      setConfig(result.config); setMessage("Codex 账号路由配置已保存");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  };
  const disabled = loading || busy;

  return <Card>
    <h2 className="text-lg font-semibold mb-2">Codex 账号路由</h2>
    <p className="text-sm text-text-muted mb-4">配置首次账号分配策略与绑定方式。绑定账号被停用或删除时重新分配，繁忙或上游过载时提示稍后重试。</p>
    <div className="space-y-4">
      <label className="flex items-center justify-between gap-4">
        <div><p className="text-sm font-medium">按 API Key 固定账号</p><p className="text-xs text-text-muted">首次请求到达时才绑定，优先选择未绑定其他 Key 的可用账号；全部已分配后，先均衡绑定 Key 数，再按下方策略分配。同 Key 的所有 Codex 会话共用账号，重启后保留；仅在账号停用、删除或额度耗尽时迁移，繁忙、冷却或过载不换号。未使用 API Key 的请求仍按会话路由。</p></div>
        <Toggle disabled={disabled} checked={config.apiKeyAffinity}
          onChange={() => setConfig({ ...config, apiKeyAffinity: !config.apiKeyAffinity })} />
      </label>
      <Select label={config.apiKeyAffinity ? "首次账号分配" : "新会话账号分配"} aria-label="账号分配策略" disabled={disabled} value={config.accountStrategy}
        options={[{ value: "inherit", label: "沿用原有账号分配策略" }, { value: "quota-priority", label: "额度优先（负载优先均衡）" }, { value: "least-loaded", label: "负载均衡（同负载轮询）" }, { value: "round-robin", label: "轮询账号（负载优先均衡）" }, { value: "fill-first", label: "账号顺序（负载优先均衡）" }]}
        onChange={event => setConfig({ ...config, accountStrategy: event.target.value })} />
      {config.accountStrategy === "quota-priority" && <p className="text-xs text-text-muted">先选择空闲账号；都忙时选择排队较少、运行请求较少的账号。负载相同时优先无过载记录的账号，再比较剩余额度，额度相同时轮询。额度全部未知时回退到轮询。</p>}
      <label className="flex items-center justify-between gap-4">
        <div><p className="text-sm font-medium">额度耗尽后迁移会话</p><p className="text-xs text-text-muted">控制按会话路由的额度迁移。按 API Key 固定账号时，额度耗尽始终自动迁移，不受此开关影响；繁忙或过载不触发换号。</p></div>
        <Toggle disabled={disabled} checked={config.quotaFailover}
          onChange={() => setConfig({ ...config, quotaFailover: !config.quotaFailover })} />
      </label>
      <label className="flex items-center justify-between gap-4">
        <div><p className="text-sm font-medium">低额度切换 Luna</p><p className="text-xs text-text-muted">单个账号 5 小时用量达到阈值时，只切换该账号；5 小时或每周总用量达到阈值时，全部账号后续请求使用 Luna。保留会话绑定，额度恢复后使用原请求模型。</p></div>
        <Toggle disabled={disabled} checked={config.quotaModelSwitch}
          onChange={() => setConfig({ ...config, quotaModelSwitch: !config.quotaModelSwitch })} />
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input label="已用额度达到（%）" aria-label="已用额度达到" type="number" min="1" max="99" step="1"
          value={config.quotaUsedPercent} disabled={disabled || !config.quotaModelSwitch}
          hint="例如 90% 表示剩余约 10% 时切换。"
          onChange={event => setConfig({ ...config, quotaUsedPercent: Number(event.target.value) })} />
        <Select label="账号分配参考周期" aria-label="账号分配参考周期" value={config.quotaWindow} disabled={disabled || config.accountStrategy !== "quota-priority"}
          options={[{ value: "any", label: "5 小时 / 每周（取较低剩余）" }, { value: "session", label: "仅 5 小时额度" }, { value: "weekly", label: "仅每周额度" }]}
          onChange={event => setConfig({ ...config, quotaWindow: event.target.value })} />
      </div>
      {config.accountStrategy === "quota-priority" && config.quotaWindow === "any" && <p className="text-xs text-text-muted">额度优先按 5 小时与每周额度中较低的剩余比例比较。</p>}
      <Select label="低额度使用的模型" aria-label="低额度使用的模型" options={models} value={config.quotaFallbackModel}
        disabled={disabled || !config.quotaModelSwitch} onChange={event => setConfig({ ...config, quotaFallbackModel: event.target.value })} />
      <p className="text-xs text-text-muted">启用对应开关后生效。只有周额度的账号，5 小时额度与周额度共用。不同套餐分别汇总，同一周期所有适用套餐都达到阈值才全局切换。额度查询失败不触发该周期的全局降级，模型须已启用；审查和 Spark 保持原模型。</p>
      <Button disabled={disabled} onClick={save}>保存账号路由</Button>
      {message && <p role="status" className="text-sm">{message}</p>}
    </div>
  </Card>;
}
