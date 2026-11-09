"use client";

import { useEffect, useState } from "react";
import { Card, Input, Button, Toggle, Select } from "@/shared/components";

const strategies = [
  { value: "inherit", label: "沿用提供商设置", description: "使用提供商或全局设置中的账号分配方式。已有会话继续使用原账号。" },
  { value: "quota-priority", label: "先选空闲，再看剩余额度", description: "先选较空闲的账号；负载相同时，选剩余额度比例更高的。额度也相同则轮流分配。", example: "例如：A、B 都空闲，A 剩余 20%，B 剩余 80%，新会话选 B。" },
  { value: "least-loaded", label: "先选空闲，再轮流分配", description: "先选较空闲的账号；负载相同时，依次轮流分配新会话。", example: "例如：A、B 一直都空闲，新会话依次分给 A、B、A、B。" },
  { value: "fill-first", label: "先选空闲，再按账号顺序", description: "先选较空闲的账号；负载相同时，选账号列表中排序靠前的。", example: "例如：A 排在 B 前面。都空闲时选 A；A 正在处理请求、B 空闲时选 B。" },
];

export default function CodexRoutingSettings() {
  const [config, setConfig] = useState(null);
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [modelAttempt, setModelAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/settings/codex-routing", { cache: "no-store", signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("设置读取失败，请重试。");
      const result = await response.json();
      if (!controller.signal.aborted) {
        setConfig(result.config); setModels(result.models || []);
        setModelsLoading(result.config.quotaModelSwitch);
      }
    }).catch(() => {
      if (!controller.signal.aborted) setLoadError("设置读取失败，请检查连接后重试。");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [loadAttempt]);

  useEffect(() => {
    if (!config?.quotaModelSwitch) return;
    const controller = new AbortController();
    fetch("/api/settings/codex-routing?models=1", { cache: "no-store", signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("模型列表读取失败");
      const result = await response.json();
      if (!controller.signal.aborted) setModels(result.models || []);
    }).catch(() => {
      if (!controller.signal.aborted) setModelsError("模型列表读取失败，可以重试；其他设置仍可保存。");
    }).finally(() => { if (!controller.signal.aborted) setModelsLoading(false); });
    return () => controller.abort();
  }, [config?.quotaModelSwitch, modelAttempt]);

  const save = async () => {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/settings/codex-routing", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "保存失败");
      setConfig(result.config); setMessage("已保存，后续请求将使用这些设置。");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  };
  // Both legacy values use the same balancing algorithm. Preserve saved values.
  const strategyValue = config?.accountStrategy === "round-robin" ? "least-loaded" : config?.accountStrategy;
  const strategy = strategies.find(item => item.value === strategyValue);
  const modelOptions = config && !models.some(model => model.value === config.quotaFallbackModel)
    ? [{ value: config.quotaFallbackModel, label: `${config.quotaFallbackModel}（当前设置）` }, ...models] : models;

  return <Card aria-label="Codex 账号路由">
    <h2 className="text-lg font-semibold mb-2">Codex 账号路由</h2>
    <p className="text-sm text-text-muted mb-5">决定新会话用哪个账号，以及额度不足时怎么办。修改后点击保存生效。</p>
    {loading ? <p role="status" className="text-sm text-text-muted py-6">正在读取已保存的设置…</p> : loadError ? <div className="space-y-3">
      <p role="alert" className="text-sm text-red-500">{loadError}</p>
      <Button variant="secondary" onClick={() => { setLoading(true); setLoadError(""); setLoadAttempt(value => value + 1); }}>重新加载设置</Button>
    </div> : config && <div className="space-y-6">
      <section aria-label="账号分配" className="space-y-4">
        <h3 className="text-sm font-semibold">账号怎么分配</h3>
        <label className="flex items-center justify-between gap-4 min-h-11">
          <div className="space-y-1"><p className="text-sm font-medium">同一个 API Key 固定使用同一账号</p><p className="text-sm text-text-muted leading-relaxed">开启：同一个 Key 的所有会话共用账号。关闭：每个新会话单独分配账号。</p></div>
          <Toggle disabled={busy} checked={config.apiKeyAffinity} ariaLabel="同一个 API Key 固定使用同一账号"
            onChange={apiKeyAffinity => setConfig({ ...config, apiKeyAffinity })} />
        </label>
        {config.apiKeyAffinity && <p className="text-sm text-text-muted leading-relaxed">首次请求时分配，重启后仍保留。先选未分给其他 Key 的账号；都已分配时，选绑定 Key 较少的，再按下方方式分配。没有 API Key 的请求仍按会话分配。</p>}
        <Select label={config.apiKeyAffinity ? "首次绑定时，如何选择账号" : "新会话如何选择账号"} aria-label="账号分配方式" aria-describedby="codex-strategy-help"
          disabled={busy} value={strategyValue} options={strategies}
          onChange={event => setConfig({ ...config, accountStrategy: event.target.value })} />
        <div id="codex-strategy-help" className="rounded-[10px] bg-surface-2 p-3 text-sm leading-relaxed space-y-1">
          <p>{strategy?.description}</p>
          {strategy?.example && <p className="text-text-muted">{strategy.example}</p>}
        </div>
        {config.accountStrategy === "quota-priority" && <Select label="用哪个周期的剩余额度比较" aria-label="额度比较周期" value={config.quotaWindow} disabled={busy}
          options={[{ value: "any", label: "5 小时和每周，取剩余比例较低的" }, { value: "session", label: "只看 5 小时额度" }, { value: "weekly", label: "只看每周额度" }]}
          hint={config.quotaWindow === "any" ? "例如：5 小时剩余 80%、每周剩余 20%，按 20% 参与比较。这里只影响选账号。" : "这里只影响选账号，不影响自动切换 Luna 的触发条件。"}
          onChange={event => setConfig({ ...config, quotaWindow: event.target.value })} />}
        <details className="text-sm text-text-muted leading-relaxed">
          <summary className="cursor-pointer py-1 focus-visible:outline focus-visible:outline-2 rounded">已有会话会换号吗？“空闲”怎么判断？</summary>
          <div className="pt-2 space-y-2">
            <p>会话分配后继续使用原账号。账号忙碌或过载时等待或提示重试，不因此自动换号；账号停用或删除后重新分配。</p>
            <p>先选还有并发名额且没有排队的账号，再比较排队数和正在处理的请求数，越少越优先。负载相同时优先避开有过载记录的账号；上面的例子假设账号都正常可用。</p>
            {config.accountStrategy === "quota-priority" && <p>额度未知的账号不会被当作满额；候选账号额度都未知时轮流分配。</p>}
          </div>
        </details>
      </section>

      <section aria-label="额度不足时的处理" className="border-t border-border-subtle pt-5 space-y-4">
        <h3 className="text-sm font-semibold">额度不足时怎么办</h3>
        <label className="flex items-center justify-between gap-4 min-h-11">
          <div className="space-y-1"><p className="text-sm font-medium">套餐额度用完后，允许使用点数（credits）</p><p className="text-sm text-text-muted leading-relaxed">开启后可消耗购买或赠送的点数继续使用。关闭时，检测到套餐额度用尽就停止使用该账号。</p></div>
          <Toggle disabled={busy} checked={config.allowCredits} ariaLabel="套餐额度用完后，允许使用点数"
            onChange={allowCredits => setConfig({ ...config, allowCredits })} />
        </label>
        <label className="flex items-center justify-between gap-4 min-h-11">
          <div className="space-y-1"><p className="text-sm font-medium">额度用完后，自动换账号继续会话</p><p className="text-sm text-text-muted leading-relaxed">关闭：保留原账号，在会话中提示 5 小时和每周额度各剩多少、何时重置。开启：有其他可用账号时自动换号继续。两种绑定方式都遵守此设置。</p></div>
          <Toggle disabled={busy} checked={config.quotaFailover} ariaLabel="额度用完后，自动换账号继续会话"
            onChange={quotaFailover => setConfig({ ...config, quotaFailover })} />
        </label>
        <label className="flex items-center justify-between gap-4 min-h-11">
          <div className="space-y-1"><p className="text-sm font-medium">额度不足时，自动改用 Luna 模型</p><p className="text-sm text-text-muted leading-relaxed">开启后可设置切换阈值。达到阈值后仍用原账号，改用 Luna；额度恢复后回到请求指定的模型。</p></div>
          <Toggle disabled={busy} checked={config.quotaModelSwitch} ariaLabel="额度不足时，自动改用 Luna 模型"
            onChange={quotaModelSwitch => { setModelsLoading(quotaModelSwitch); setModelsError(""); setConfig({ ...config, quotaModelSwitch }); }} />
        </label>
        {config.quotaModelSwitch && <div className="rounded-[10px] bg-surface-2 p-4 space-y-4">
          <Input label="已用额度达到多少时切换（%）" aria-label="已用额度切换阈值" type="number" min="1" max="99" step="1"
            value={config.quotaUsedPercent} disabled={busy}
            hint={`当前设为已用 ${config.quotaUsedPercent}%，即剩余约 ${100 - config.quotaUsedPercent}% 时切换。`}
            onChange={event => setConfig({ ...config, quotaUsedPercent: Number(event.target.value) })} />
          <Select label="切换后使用的模型" aria-label="切换后使用的模型" options={modelOptions} value={config.quotaFallbackModel}
            disabled={busy || modelsLoading} onChange={event => setConfig({ ...config, quotaFallbackModel: event.target.value })} />
          <div className="text-sm text-text-muted space-y-2" aria-live="polite">
            {modelsLoading ? <p role="status">正在查询可用模型，其他设置仍可修改和保存…</p> : <>
              {modelsError ? <p role="alert">{modelsError}</p> : !models.length ? <p>未查到可选的 Luna 模型。请确认账号已启用该模型后重试；当前设置会保留。</p>
                : !models.some(model => model.value === config.quotaFallbackModel) && <p>当前模型暂未出现在可用列表中，可以保留设置或选择其他模型。</p>}
              <Button variant="secondary" disabled={busy} onClick={() => { setModelsLoading(true); setModelsError(""); setModelAttempt(value => value + 1); }}>重新加载模型</Button>
            </>}
          </div>
          <p className="text-sm text-text-muted leading-relaxed">单个账号的 5 小时用量达到阈值，只切换该账号；所有适用套餐的汇总用量在同一周期（5 小时或每周）都达到阈值，才切换全部账号。</p>
        </div>}
        <details className="text-sm text-text-muted leading-relaxed">
          <summary className="cursor-pointer py-1 focus-visible:outline focus-visible:outline-2 rounded">点数和模型切换的补充说明</summary>
          <div className="pt-2 space-y-2">
            <p>点数开关仅适用于普通 Codex 请求，不放宽 Spark 和审查额度；额度重置券仍需手动使用。</p>
            <p>只有周额度的账号，5 小时与每周按同一份额度计算。不同套餐分别汇总；查询失败时不触发该周期的全部账号切换。Luna 须已在账号中启用；Spark 和审查请求保持原模型。</p>
          </div>
        </details>
      </section>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy} loading={busy} onClick={save}>{busy ? "正在保存…" : "保存账号路由"}</Button>
        {message && <p role="status" className="text-sm">{message}</p>}
      </div>
    </div>}
  </Card>;
}
