"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Button from "@/shared/components/Button";
import Modal from "@/shared/components/Modal";
import CodexTrialOutput from "./CodexTrialOutput";
import CodexTrialPreview from "./CodexTrialPreview";
import CodexTrialErrors from "./CodexTrialErrors";
import CodexTrialModels, { trialDefaultEffort } from "./CodexTrialModels";
import CodexTrialAccountActions from "./CodexTrialAccountActions";
import { formatTrialErrorLog, formatTrialLog } from "@/shared/utils/codexTrialOutput";
import { CODEX_TRIAL_PROMPT, CODEX_TRIAL_PROMPT_LIMIT, CODEX_TRIAL_MODEL, CODEX_TRIAL_EFFORT, CODEX_TRIAL_PARALLEL, CODEX_TRIAL_MAX_PARALLEL } from "@/shared/utils/codexTrial";
import { CODEX_TRIAL_DEGRADATION_LIMITS, getTrialDegradationMetrics, matchesTrialDegradationRule } from "@/shared/utils/codexTrialQuality";

const panel = "rounded-2xl border border-border bg-surface shadow-[var(--shadow-soft)]";
const control = "min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text-main outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50";
const states = {
  queued: ["排队中", "text-text-muted bg-surface-2"], running: ["生成中", "text-blue-700 bg-blue-500/10 dark:text-blue-300"],
  success: ["已生成", "text-emerald-700 bg-emerald-500/10 dark:text-emerald-300"], error: ["失败", "text-red-700 bg-red-500/10 dark:text-red-300"],
  cancelled: ["已取消", "text-text-muted bg-surface-2"], interrupted: ["已中断", "text-amber-700 bg-amber-500/10 dark:text-amber-300"],
};
const effortLabels = { low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高" };
const number = value => typeof value === "number" ? value.toLocaleString("zh-CN") : "—";
const elapsed = ms => typeof ms !== "number" ? "—" : ms < 60_000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.floor(ms / 60_000)} 分 ${Math.floor(ms % 60_000 / 1000)} 秒`;
const artifactUrl = (account, format = "html") => `/api/codex-trials/${encodeURIComponent(account.result.id)}?format=${format}&v=${account.result.runId}`;

function Metric({ label, children, danger }) {
  return <div><dt className="text-[11px] text-text-muted">{label}</dt><dd className={`mt-1 text-base font-semibold tabular-nums ${danger ? "text-red-600 dark:text-red-400" : "text-text-main"}`}>{children}</dd></div>;
}

function AccountCard({ account, busy, models, selectedProvider, now, onRun, onInspect, onUpdated }) {
  const result = account.result;
  const lowMetrics = getTrialDegradationMetrics(result);
  const degraded = lowMetrics.length > 0;
  const active = result => ["queued", "running"].includes(result?.status);
  const selectedActive = account.results?.some(result => active(result) && models.some(item => item.model === result.model));
  const [status, color] = states[result?.status] || ["未测试", "text-text-muted bg-surface-2"];
  const duration = result?.status === "running" && result.startedAt ? Math.max(0, now - new Date(result.startedAt).getTime()) : result?.elapsedMs;
  return <article className={`${panel} min-w-0 overflow-hidden`}>
    <div className="flex items-start justify-between gap-3 p-4">
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold" title={account.name}>{account.name}</h2>
        <p className="mt-1 text-xs font-medium text-text-muted">{account.providerName}</p>
        {result && <p className="mt-1 break-all text-sm font-medium text-primary">{result.model} · {effortLabels[result.effort] || result.effort || "模型默认"}</p>}
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-muted">
          <span className={account.enabled ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"}>{account.enabled ? "已启用" : "已禁用 · 仍可测试"}</span>
          <span className="truncate" title={account.id}>{account.email !== account.name ? account.email : account.id.slice(0, 8)}</span>
        </div>
        <CodexTrialAccountActions account={account} onUpdated={onUpdated} />
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${color}`}>{status}</span>
        {degraded && <span data-trial-degradation className="rounded-md bg-red-500/10 px-2.5 py-1 text-xs font-semibold text-red-700 dark:text-red-300" title="任意一项低于本页自定规则的阈值">降智表现 · 规则命中</span>}
      </div>
    </div>
    <div className="relative h-80 border-y border-border bg-surface-2">
      {result?.hasHtml ? <CodexTrialPreview key={result.runId} title={`${account.name} 的 HTML 作品`} src={artifactUrl(account)} className="h-full w-full" />
        : result?.status === "running" ? <CodexTrialOutput key={result.runId} result={result} text={result.outputTail} now={now} className="h-full" />
        : <div className="flex h-full flex-col items-center justify-center gap-3 overflow-auto p-6 text-center">
        <span className={`material-symbols-outlined text-[36px] ${result?.status === "error" ? "text-red-500" : "text-text-muted"} ${result?.status === "running" ? "animate-spin motion-reduce:animate-none" : ""}`}>
          {result?.error ? "error_outline" : "code"}
        </span>
        <p className="text-sm font-medium">{result?.error ? "本次测试未完成" : result?.status === "queued" ? "等待可用测试位置" : "等待生成作品"}</p>
        <p className={`max-w-full whitespace-pre-wrap break-words text-xs leading-5 ${result?.error ? "max-h-32 overflow-auto text-red-600 dark:text-red-400" : "text-text-muted"}`}>
          {result?.error || (result?.status === "running" ? "离开或刷新页面不会中断测试。" : "测试后，作品与指标将保存在这里。")}
        </p>
      </div>}
    </div>
    <div className="p-4">
      <dl className="grid grid-cols-3 gap-3 sm:grid-cols-5 sm:gap-2">
        <Metric label="输出 tok/s" danger={lowMetrics.includes("tokensPerSecond")}>{typeof result?.tokensPerSecond === "number" ? result.tokensPerSecond.toFixed(1) : "—"}</Metric>
        <Metric label="中转错误" danger={result?.routerStatsVersion === 3 && result.routerErrors > 0}>
          {result ? <button type="button" className="cursor-pointer rounded underline decoration-dotted underline-offset-4 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={`查看 ${account.name} 本次测试的中转错误`} onClick={() => onInspect(account, "errors")}>{number(result.routerStatsVersion === 3 ? result.routerErrors : null)}</button> : "—"}
        </Metric>
        <Metric label="输出 tokens" danger={lowMetrics.includes("outputTokens")}>{number(result?.usage?.output_tokens)}</Metric>
        <Metric label="总耗时">{elapsed(duration)}</Metric>
        <Metric label="HTML 行数" danger={lowMetrics.includes("htmlLines")}>{result?.hasHtml ? number(result.htmlLines) : "—"}</Metric>
      </dl>
      <div className="mt-4 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-text-muted">
        {!result && <span>使用上方所选模型</span>}
        {result && <>
          <button type="button" className={`min-h-9 cursor-pointer underline decoration-dotted underline-offset-4 hover:text-primary ${result.cliErrors ? "text-red-600 dark:text-red-400" : ""}`}
            title="查看 Codex 执行时的报错与重试提示" onClick={() => onInspect(account, "cli-errors")}>CLI 报错 {result.cliErrors || 0} 次 ↗</button>
          <button type="button" className="min-h-9 cursor-pointer text-primary underline decoration-dotted underline-offset-4"
            title="查看本轮测试的成功、失败及重试请求" onClick={() => onInspect(account, "requests")}>本轮请求 {result.requests || 0} 次 ↗</button>
        </>}
      </div>
      {result?.finishedAt && <p className="mt-1 text-[11px] text-text-muted">{new Date(result.finishedAt).toLocaleString("zh-CN")}</p>}
      {result && result.routerStatsVersion !== 3 && <p className="mt-1 text-[11px] text-text-muted">旧记录的中转错误计数需重新测试后更新。</p>}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" disabled={busy || active(result)} icon="play_arrow" onClick={() => onRun(account, result)}>{result ? "重测此模型" : "测试此账号"}</Button>
        {result && account.firstResult && account.provider === selectedProvider && <Button size="sm" variant="ghost" disabled={busy || selectedActive} onClick={() => onRun(account)}>测试所选模型</Button>}
        {result?.hasHtml && <Button size="sm" variant="ghost" onClick={() => onInspect(account, "preview")}>放大</Button>}
        {result && <Button size="sm" variant="ghost" onClick={() => onInspect(account, "log")}>执行输出</Button>}
        <Link className="ml-auto py-1 text-xs font-medium text-primary hover:underline" href={`/dashboard/diagnostics?focusConnectionId=${encodeURIComponent(account.id)}`}>请求明细 ↗</Link>
      </div>
    </div>
  </article>;
}

export default function CodexTrialsPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [prompt, setPrompt] = useState(CODEX_TRIAL_PROMPT);
  const [providerId, setProviderId] = useState("codex");
  const [modelSelections, setModelSelections] = useState({ codex: [{ model: CODEX_TRIAL_MODEL, effort: CODEX_TRIAL_EFFORT }] });
  const [parallel, setParallel] = useState(CODEX_TRIAL_PARALLEL);
  const [submitting, setSubmitting] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [now, setNow] = useState(0);
  const [inspector, setInspector] = useState(null);
  const [detail, setDetail] = useState(null);
  const sequence = useRef(0);
  const provider = data?.providers?.find(item => item.id === providerId) || data?.providers?.[0];
  const models = modelSelections[provider?.id] || (provider ? [{ model: provider.defaultModel, effort: trialDefaultEffort(provider.id, provider.defaultModel) }] : []);
  const setModels = value => setModelSelections(previous => ({ ...previous, [provider.id]: value }));
  const validParallel = Number.isInteger(parallel) && parallel >= 1 && parallel <= CODEX_TRIAL_MAX_PARALLEL;
  const busy = submitting || data?.stopping || !data?.cli?.available || !validParallel;
  const load = useCallback(async signal => {
    const current = ++sequence.current;
    try {
      const response = await fetch("/api/codex-trials", { cache: "no-store", signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10000)]) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "读取测试记录失败。");
      // Trial timestamps and elapsed time must use the same server clock.
      if (sequence.current === current && !signal?.aborted) { setData(payload); setNow(payload.serverNow ?? Date.now()); setReadError(""); }
    } catch (cause) { if (sequence.current === current && !signal?.aborted) setReadError(cause.message); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer;
    const refresh = async () => {
      if (!document.hidden && !controller.signal.aborted) await load(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(refresh, 1000);
    };
    Promise.resolve().then(refresh);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [load]);
  useEffect(() => {
    if (!inspector || !["log", "cli-errors"].includes(inspector.mode)) return;
    const controller = new AbortController();
    let timer;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/codex-trials/${encodeURIComponent(inspector.account.result.id)}`, { signal: controller.signal, cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error);
        if (controller.signal.aborted) return;
        setDetail(payload);
        if (["queued", "running"].includes(payload.status)) timer = setTimeout(refresh, 1000);
      } catch (cause) { if (!controller.signal.aborted) { setDetail({ error: cause.message }); timer = setTimeout(refresh, 3000); } }
    };
    Promise.resolve().then(refresh);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [inspector]);
  async function submit(payload) {
    setSubmitting(true); setError("");
    try {
      const response = await fetch("/api/codex-trials", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "启动测试失败。");
      await load();
    } catch (cause) { setError(cause.message); }
    finally { setSubmitting(false); }
  }
  const run = (account, result) => submit({ provider: account?.provider || provider?.id, prompt, parallel: data?.parallel ?? parallel,
    models: result ? [{ model: result.model, effort: result.effort }] : models, ...(account ? { ids: [account.id] } : { all: true }) });
  const inspect = (account, mode) => { setDetail(null); setInspector({ account, mode }); };
  const accounts = data?.accounts || [];
  const selectedAccounts = accounts.filter(account => account.provider === provider?.id);
  const cards = accounts.filter(account => account.provider === provider?.id || account.results?.length).flatMap(account => (account.results?.length ? account.results : [account.result || null])
    .map((result, index) => ({ ...account, result, firstResult: index === 0 })));
  const success = cards.filter(account => account.result?.status === "success").length;
  const failures = cards.filter(account => ["error", "interrupted"].includes(account.result?.status)).length;
  const degraded = cards.filter(account => matchesTrialDegradationRule(account.result)).length;
  const running = cards.filter(account => account.result?.status === "running").length;
  const queued = cards.filter(account => account.result?.status === "queued").length;
  const visible = cards.filter(account => `${account.providerName} ${account.provider} ${account.name} ${account.email} ${account.id} ${account.qualityLabel || ""} ${account.result?.model || ""}`.toLowerCase().includes(search.toLowerCase()))
    .filter(account => filter === "all" || (filter === "degraded" ? matchesTrialDegradationRule(account.result) : filter === "disabled" ? !account.enabled : filter === "error" ? ["error", "interrupted"].includes(account.result?.status) : account.result?.status === filter));
  return <div data-i18n-skip className="flex min-w-0 flex-col gap-6 text-text-main">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="mb-2 text-xs font-medium text-text-muted">Codex CLI → 9router → 所选供应商的指定账号</p><h1 className="text-2xl font-semibold tracking-tight">账号测试</h1>
        <p className="mt-2 text-sm text-text-muted">同一提示词，比较不同供应商、账号和模型的作品。包含禁用账号。</p></div>
      <span className={`rounded-full px-3 py-1.5 text-xs ${data?.cli?.available ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-surface-2 text-text-muted"}`}>{data?.cli?.version || (data ? "CLI 未就绪" : "正在连接…")}</span>
    </div>
    <section className={`${panel} p-5`} aria-label="测试配置">
      <label className="mb-4 block text-sm font-medium" htmlFor="account-trial-provider">供应商
        <select id="account-trial-provider" className={`${control} mt-2`} value={provider?.id || ""} disabled={submitting || !data?.providers?.length} onChange={event => setProviderId(event.target.value)}>
          {!data?.providers?.length && <option value="">暂无可测试的供应商</option>}
          {data?.providers?.map(item => <option key={item.id} value={item.id}>{item.name} · {accounts.filter(account => account.provider === item.id).length} 个账号</option>)}
        </select>
      </label>
      <label htmlFor="codex-trial-prompt" className="text-sm font-medium">提示词</label>
      <textarea id="codex-trial-prompt" rows={3} value={prompt} maxLength={CODEX_TRIAL_PROMPT_LIMIT} onChange={event => setPrompt(event.target.value)} disabled={submitting} className={`${control} mt-2 resize-y py-3 leading-6`} />
      <CodexTrialModels provider={provider} models={models} onChange={setModels} disabled={submitting} />
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-text-muted">{selectedAccounts.length} 个账号 × {models.length} 个模型 · 共 {selectedAccounts.length * models.length} 项测试</p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex items-center gap-2 text-sm" htmlFor="codex-trial-parallel">并发数
            <input id="codex-trial-parallel" type="number" min={1} max={CODEX_TRIAL_MAX_PARALLEL} step={1}
              value={data?.running ? data.parallel ?? parallel : parallel} onChange={event => setParallel(event.target.value === "" ? "" : Number(event.target.value))}
              disabled={data?.running || submitting} aria-invalid={!validParallel} aria-describedby="codex-trial-parallel-help" className={`${control} !w-20`} />
          </label>
          {data?.running && <Button variant="danger" size="lg" disabled={submitting} icon="stop" onClick={() => submit({ action: "stop" })}>停止全部测试</Button>}
          <Button size="lg" icon="play_arrow" loading={submitting} disabled={busy || !selectedAccounts.length || !prompt.trim() || !models.length || models.some(item => !item.model.trim())} onClick={() => run()}>测试该供应商全部账号</Button>
        </div>
      </div>
      <p id="codex-trial-parallel-help" className={`mt-3 text-xs ${validParallel ? "text-text-muted" : "text-red-600 dark:text-red-400"}`}>
        {validParallel ? `最多同时执行 ${data?.running ? data.parallel ?? parallel : parallel} 项，完成一项后自动补下一项。其他测试可随时加入，满额时排队；同一账号仍遵守已有的并发限制。` : `请输入 1–${CODEX_TRIAL_MAX_PARALLEL} 之间的整数。`}
      </p>
      <p className="mt-4 text-xs leading-5 text-text-muted">切换供应商后，已有作品仍在下方一起展示。每个账号、模型分别保存，重测失败直接显示错误。测试使用账号额度，模型需支持工具调用以生成文件；CLI 仅在测试期间运行。</p>
    </section>
    {(error || readError || data?.cli?.error) && <p role="alert" className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-700 dark:text-red-300">{error || readError || data.cli.error}</p>}
    <div className="flex flex-wrap items-center justify-between gap-4">
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-live="polite"><span className="text-text-muted">全部 <b className="text-text-main">{accounts.length}</b></span><span className="text-emerald-700 dark:text-emerald-400">已生成 {success}</span><span className="text-red-600 dark:text-red-400">降智表现 {degraded}</span><span className="text-red-600 dark:text-red-400">失败 {failures}</span>{running > 0 && <span className="text-blue-600 dark:text-blue-400">执行中 {running}</span>}{queued > 0 && <span className="text-text-muted">排队中 {queued}</span>}</p>
      <div className="flex flex-wrap gap-2"><input aria-label="搜索账号、供应商或模型" className={`${control} sm:!w-52`} placeholder="搜索账号、供应商或模型…" value={search} onChange={event => setSearch(event.target.value)} /><select aria-label="筛选测试结果" className={`${control} sm:!w-40`} value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部结果</option><option value="disabled">禁用账号</option><option value="success">已生成</option><option value="degraded">降智表现（规则命中）</option><option value="error">失败 / 中断</option></select></div>
    </div>
    <div className="-mt-3 space-y-1 text-xs leading-5 text-text-muted">
      <p>自定标记规则：已生成样本满足任一条件即标记为“降智表现”：HTML 少于 {CODEX_TRIAL_DEGRADATION_LIMITS.htmlLines} 行、速率低于 {CODEX_TRIAL_DEGRADATION_LIMITS.tokensPerSecond} tok/s，或输出少于 {number(CODEX_TRIAL_DEGRADATION_LIMITS.outputTokens)} tokens。每个账号、模型分别判断，已有结果自动适用。</p>
      <p>速率 = CLI 输出 tokens ÷ 总耗时，包含思考、等待和文件生成。中转错误按失败请求计数，重试另计；可结合“请求明细”查看原因。</p>
    </div>
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">{visible.map(account => <AccountCard key={account.result?.id || account.id} account={account} busy={busy} models={models} selectedProvider={provider?.id} now={now} onRun={run} onInspect={inspect} onUpdated={() => load()} />)}</div>
    {data && !visible.length && <div className={`${panel} p-12 text-center text-sm text-text-muted`}>{accounts.length ? "没有符合筛选条件的账号。" : "尚未添加可测试的供应商账号。"}</div>}
    {["errors", "requests"].includes(inspector?.mode) && <CodexTrialErrors key={`${inspector.account.result.runId}:${inspector.mode}`}
      initialIssue={inspector.mode === "requests" ? "all" : "error"}
      account={cards.find(account => account.result?.id === inspector.account.result.id) || inspector.account} onClose={() => setInspector(null)} />}
    <Modal isOpen={!!inspector && !["errors", "requests"].includes(inspector.mode)} blurBackdrop={false} onClose={() => setInspector(null)} title={inspector ? `${inspector.account.providerName} · ${inspector.account.name} · ${inspector.account.result.model}${inspector.mode === "cli-errors" ? " · CLI 报错" : ""}` : ""} size="full"
      footer={<><Button variant="secondary" onClick={() => setInspector(null)}>关闭</Button>{inspector?.account.result?.hasHtml && <a className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white" href={artifactUrl(inspector.account, "download")} download>下载 HTML</a>}</>}>
      {inspector?.mode === "preview" ? <CodexTrialPreview key={inspector.account.result?.runId} title={`${inspector.account.name} 的完整作品`} src={artifactUrl(inspector.account)} className="h-[60vh] w-full rounded-lg" />
        : <div className="space-y-4"><p className="text-xs text-text-muted">{detail ? `${detail.model || ""} · ${detail.effort || ""} · ${detail.cliVersion || ""}` : "正在读取记录…"}</p>{detail?.reportedModels?.length > 0 && <p className="text-xs text-text-muted">上游返回模型：{detail.reportedModels.join("、")}</p>}{inspector?.mode !== "cli-errors" && detail?.prompt && <p className="whitespace-pre-wrap text-sm">{detail.prompt}</p>}{inspector?.mode !== "cli-errors" && detail?.error && <p className="whitespace-pre-wrap break-words text-sm text-red-600">{detail.error}</p>}
          {inspector?.mode === "cli-errors" && <p className="text-xs text-text-muted">这是 Codex 执行时的报错和重试提示，相同原因合并展示；不代表最终测试失败次数。同一次故障也可能记录为中转错误。</p>}
          <CodexTrialOutput key={`${detail?.runId}:${inspector?.mode}`} result={detail}
            title={inspector?.mode === "cli-errors" ? "CLI 报错与重试提示" : undefined}
            text={inspector?.mode === "cli-errors" ? detail ? formatTrialErrorLog(detail.log, detail.error) || (detail.cliErrors ? `CLI 记录了 ${detail.cliErrors} 次报错，但已保留日志中没有对应原文。` : "本轮没有 CLI 报错。") : "正在读取 CLI 报错…" : detail?.output || formatTrialLog(detail?.log)} now={now} className="h-[45vh] rounded-xl" />
          {inspector?.mode === "cli-errors" && <Button size="sm" variant="secondary" onClick={() => inspect(inspector.account, "log")}>查看全部执行输出</Button>}
          {detail?.log && <details><summary className="cursor-pointer text-xs text-text-muted">原始 CLI 日志</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-surface-2 p-4 text-xs leading-5">{detail.log}</pre></details>}
        </div>}
    </Modal>
  </div>;
}
