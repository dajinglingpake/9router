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
    <p className="text-sm text-text-muted mb-4">默认沿用原有账号策略，自动切换默认关闭。手动配置并保存后生效，已有会话保持账号绑定。</p>
    <div className="space-y-4">
      <Select label="新会话账号分配" aria-label="新会话账号分配" disabled={disabled} value={config.accountStrategy}
        options={[{ value: "inherit", label: "沿用原有账号分配策略" }, { value: "quota-priority", label: "额度优先（空闲账号优先）" }, { value: "least-loaded", label: "负载均衡（空闲账号优先轮询）" }, { value: "round-robin", label: "轮询账号（优先空闲）" }, { value: "fill-first", label: "优先填满第一个账号" }]}
        onChange={event => setConfig({ ...config, accountStrategy: event.target.value })} />
      {config.accountStrategy === "quota-priority" && <p className="text-xs text-text-muted">新会话选择空闲账号中剩余额度最高的；都忙时选择全部可用账号中剩余额度最高的并排队。额度相同时轮询，已有会话保持绑定。额度全部未知时回退到轮询。</p>}
      <label className="flex items-center justify-between gap-4">
        <div><p className="text-sm font-medium">额度耗尽后迁移会话</p><p className="text-xs text-text-muted">选择其他可用账号并重新绑定；短暂限流和过载继续等待原账号。</p></div>
        <Toggle disabled={disabled} checked={config.quotaFailover}
          onChange={() => setConfig({ ...config, quotaFailover: !config.quotaFailover })} />
      </label>
      <label className="flex items-center justify-between gap-4">
        <div><p className="text-sm font-medium">低额度切换 Luna</p><p className="text-xs text-text-muted">保留当前账号，在后续请求使用 Luna。额度恢复后使用原请求模型。</p></div>
        <Toggle disabled={disabled} checked={config.quotaModelSwitch}
          onChange={() => setConfig({ ...config, quotaModelSwitch: !config.quotaModelSwitch })} />
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input label="已用额度达到（%）" aria-label="已用额度达到" type="number" min="1" max="99" step="1"
          value={config.quotaUsedPercent} disabled={disabled || !config.quotaModelSwitch}
          hint="例如 90% 表示剩余约 10% 时切换。"
          onChange={event => setConfig({ ...config, quotaUsedPercent: Number(event.target.value) })} />
        <Select label="检查额度周期" aria-label="检查额度周期" value={config.quotaWindow} disabled={disabled || (!config.quotaModelSwitch && config.accountStrategy !== "quota-priority")}
          options={[{ value: "any", label: "5 小时 / 每周（取较低剩余）" }, { value: "session", label: "仅 5 小时额度" }, { value: "weekly", label: "仅每周额度" }]}
          onChange={event => setConfig({ ...config, quotaWindow: event.target.value })} />
      </div>
      {config.accountStrategy === "quota-priority" && config.quotaWindow === "any" && <p className="text-xs text-text-muted">额度优先按 5 小时与每周额度中较低的剩余比例比较。</p>}
      <Select label="低额度使用的模型" aria-label="低额度使用的模型" options={models} value={config.quotaFallbackModel}
        disabled={disabled || !config.quotaModelSwitch} onChange={event => setConfig({ ...config, quotaFallbackModel: event.target.value })} />
      <p className="text-xs text-text-muted">启用对应开关后，才按额度迁移账号或切换模型。模型切换需要有效额度数据且账号已启用对应模型；额度查询失败不会触发降级，审查和 Spark 使用各自额度。</p>
      <Button disabled={disabled} onClick={save}>保存账号路由</Button>
      {message && <p role="status" className="text-sm">{message}</p>}
    </div>
  </Card>;
}
