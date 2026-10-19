"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Button from "@/shared/components/Button";
import Modal from "@/shared/components/Modal";
import CodexTrialOutput from "./CodexTrialOutput";
import CodexTrialPreview from "./CodexTrialPreview";
import CodexTrialErrors from "./CodexTrialErrors";
import CodexTrialModels from "./CodexTrialModels";
import CodexTrialAccountActions from "./CodexTrialAccountActions";
import { formatTrialLog } from "@/shared/utils/codexTrialOutput";
import { CODEX_TRIAL_PROMPT, CODEX_TRIAL_PROMPT_LIMIT, CODEX_TRIAL_MODEL, CODEX_TRIAL_EFFORT } from "@/shared/utils/codexTrial";

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

function AccountCard({ account, busy, now, onRun, onInspect, onUpdated }) {
  const result = account.result;
  const [status, color] = states[result?.status] || ["未测试", "text-text-muted bg-surface-2"];
  const duration = result?.status === "running" && result.startedAt ? now - new Date(result.startedAt).getTime() : result?.elapsedMs;
  return <article className={`${panel} min-w-0 overflow-hidden`}>
    <div className="flex items-start justify-between gap-3 p-4">
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold" title={account.name}>{account.name}</h2>
        {result && <p className="mt-1 break-all text-sm font-medium text-primary">{result.model} · {effortLabels[result.effort] || result.effort}</p>}
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-muted">
          <span className={account.enabled ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"}>{account.enabled ? "已启用" : "已禁用 · 仍可测试"}</span>
          <span className="truncate" title={account.id}>{account.email !== account.name ? account.email : account.id.slice(0, 8)}</span>
        </div>
        <CodexTrialAccountActions account={account} onUpdated={onUpdated} />
      </div>
      <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${color}`}>{status}</span>
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
        <Metric label="输出 tok/s">{typeof result?.tokensPerSecond === "number" ? result.tokensPerSecond.toFixed(1) : "—"}</Metric>
        <Metric label="中转错误" danger={result?.routerStatsVersion === 3 && result.routerErrors > 0}>
          {result ? <button type="button" className="cursor-pointer rounded underline decoration-dotted underline-offset-4 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={`查看 ${account.name} 本次测试的中转错误`} onClick={() => onInspect(account, "errors")}>{number(result.routerStatsVersion === 3 ? result.routerErrors : null)}</button> : "—"}
        </Metric>
        <Metric label="输出 tokens">{number(result?.usage?.output_tokens)}</Metric>
        <Metric label="总耗时">{elapsed(duration)}</Metric>
        <Metric label="HTML 行数">{result?.hasHtml ? number(result.htmlLines) : "—"}</Metric>
      </dl>
      <div className="mt-4 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-text-muted">
        {!result && <span>使用上方所选模型</span>}
        {result && <><span>CLI 错误 {result.cliErrors || 0}</span><span>中转请求 {result.requests || 0}</span><span>累计失败 {result.failures}/{result.attempts}</span></>}
      </div>
      {result?.finishedAt && <p className="mt-1 text-[11px] text-text-muted">{new Date(result.finishedAt).toLocaleString("zh-CN")}</p>}
      {result && result.routerStatsVersion !== 3 && <p className="mt-1 text-[11px] text-text-muted">旧记录的中转错误计数需重新测试后更新。</p>}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" disabled={busy} icon="play_arrow" onClick={() => onRun(account.id, result)}>{result ? "重测此模型" : "测试此账号"}</Button>
        {result && account.firstResult && <Button size="sm" variant="ghost" disabled={busy} onClick={() => onRun(account.id)}>测试所选模型</Button>}
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
  const [models, setModels] = useState([{ model: CODEX_TRIAL_MODEL, effort: CODEX_TRIAL_EFFORT }]);
  const [submitting, setSubmitting] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [now, setNow] = useState(0);
  const [inspector, setInspector] = useState(null);
  const [detail, setDetail] = useState(null);
  const sequence = useRef(0);
  const busy = submitting || data?.running || !data?.cli?.available;
  const load = useCallback(async signal => {
    const current = ++sequence.current;
    try {
      const response = await fetch("/api/codex-trials", { cache: "no-store", signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "读取测试记录失败。");
      if (sequence.current === current && !signal?.aborted) { setData(payload); setNow(Date.now()); setReadError(""); }
    } catch (cause) { if (sequence.current === current && !signal?.aborted) setReadError(cause.message); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => { if (!controller.signal.aborted) load(controller.signal); };
    Promise.resolve().then(refresh);
    const timer = setInterval(refresh, 1000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [load]);
  useEffect(() => {
    if (!inspector || inspector.mode !== "log") return;
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
  const run = (id, result) => submit({ prompt, models: result ? [{ model: result.model, effort: result.effort }] : models, ...(id ? { ids: [id] } : { all: true }) });
  const inspect = (account, mode) => { setDetail(null); setInspector({ account, mode }); };
  const accounts = data?.accounts || [];
  const cards = accounts.flatMap(account => (account.results?.length ? account.results : [account.result || null])
    .map((result, index) => ({ ...account, result, firstResult: index === 0 })));
  const success = cards.filter(account => account.result?.status === "success").length;
  const failures = cards.filter(account => ["error", "interrupted"].includes(account.result?.status)).length;
  const inProgress = cards.filter(account => ["queued", "running"].includes(account.result?.status)).length;
  const visible = cards.filter(account => `${account.name} ${account.email} ${account.id} ${account.qualityLabel || ""} ${account.result?.model || ""}`.toLowerCase().includes(search.toLowerCase()))
    .filter(account => filter === "all" || (filter === "disabled" ? !account.enabled : filter === "error" ? ["error", "interrupted"].includes(account.result?.status) : account.result?.status === filter));
  return <div data-i18n-skip className="flex min-w-0 flex-col gap-6 text-text-main">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="mb-2 text-xs font-medium text-text-muted">Codex CLI → 9router → 指定账号</p><h1 className="text-2xl font-semibold tracking-tight">Codex 账号测试</h1>
        <p className="mt-2 text-sm text-text-muted">同一提示词，比较不同账号和模型的作品。包含禁用账号。</p></div>
      <span className={`rounded-full px-3 py-1.5 text-xs ${data?.cli?.available ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-surface-2 text-text-muted"}`}>{data?.cli?.version || (data ? "CLI 未就绪" : "正在连接…")}</span>
    </div>
    <section className={`${panel} p-5`} aria-label="测试配置">
      <label htmlFor="codex-trial-prompt" className="text-sm font-medium">提示词</label>
      <textarea id="codex-trial-prompt" rows={3} value={prompt} maxLength={CODEX_TRIAL_PROMPT_LIMIT} onChange={event => setPrompt(event.target.value)} disabled={data?.running || submitting} className={`${control} mt-2 resize-y py-3 leading-6`} />
      <CodexTrialModels models={models} onChange={setModels} disabled={data?.running || submitting} />
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-text-muted">{accounts.length} 个账号 × {models.length} 个模型 · 共 {accounts.length * models.length} 项测试</p>
        <div className="flex items-end gap-2">
          {data?.running ? <Button variant="danger" size="lg" disabled={submitting} icon="stop" onClick={() => submit({ action: "stop" })}>停止测试</Button>
            : <Button size="lg" icon="play_arrow" loading={submitting} disabled={busy || !accounts.length || !prompt.trim()} onClick={() => run()}>一键测试全部</Button>}
        </div>
      </div>
      <p className="mt-4 text-xs leading-5 text-text-muted">每个账号、每个模型的作品分别保存。重测只替换对应模型的结果，失败直接显示错误。测试会使用各账号额度；CLI 仅在测试期间运行。</p>
    </section>
    {(error || readError || data?.cli?.error) && <p role="alert" className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-700 dark:text-red-300">{error || readError || data.cli.error}</p>}
    <div className="flex flex-wrap items-center justify-between gap-4">
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-live="polite"><span className="text-text-muted">全部 <b className="text-text-main">{accounts.length}</b></span><span className="text-emerald-700 dark:text-emerald-400">已生成 {success}</span><span className="text-red-600 dark:text-red-400">失败 {failures}</span>{inProgress > 0 && <span className="text-blue-600 dark:text-blue-400">排队 / 生成 {inProgress}</span>}</p>
      <div className="flex flex-wrap gap-2"><input aria-label="搜索账号" className={`${control} sm:!w-52`} placeholder="搜索账号…" value={search} onChange={event => setSearch(event.target.value)} /><select aria-label="筛选测试结果" className={`${control} sm:!w-40`} value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部账号</option><option value="disabled">禁用账号</option><option value="success">已生成</option><option value="error">失败 / 中断</option></select></div>
    </div>
    <p className="-mt-3 text-xs leading-5 text-text-muted">速率 = CLI 输出 tokens ÷ 总耗时，包含思考、等待和文件生成。中转错误按失败请求计数，重试另计；可结合“请求明细”查看原因。作品用于人工比较，不自动判定账号质量。</p>
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">{visible.map(account => <AccountCard key={account.result?.id || account.id} account={account} busy={busy} now={now} onRun={run} onInspect={inspect} onUpdated={() => load()} />)}</div>
    {data && !visible.length && <div className={`${panel} p-12 text-center text-sm text-text-muted`}>{accounts.length ? "没有符合筛选条件的账号。" : "尚未添加 Codex 账号。"}</div>}
    {inspector?.mode === "errors" && <CodexTrialErrors key={inspector.account.result.runId}
      account={cards.find(account => account.result?.id === inspector.account.result.id) || inspector.account} onClose={() => setInspector(null)} />}
    <Modal isOpen={!!inspector && inspector.mode !== "errors"} onClose={() => setInspector(null)} title={inspector ? `${inspector.account.name} · ${inspector.account.result.model}` : ""} size="full"
      footer={<><Button variant="secondary" onClick={() => setInspector(null)}>关闭</Button>{inspector?.account.result?.hasHtml && <a className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white" href={artifactUrl(inspector.account, "download")} download>下载 HTML</a>}</>}>
      {inspector?.mode === "preview" ? <CodexTrialPreview key={inspector.account.result?.runId} title={`${inspector.account.name} 的完整作品`} src={artifactUrl(inspector.account)} className="h-[60vh] w-full rounded-lg" />
        : <div className="space-y-4"><p className="text-xs text-text-muted">{detail ? `${detail.model || ""} · ${detail.effort || ""} · ${detail.cliVersion || ""}` : "正在读取记录…"}</p>{detail?.reportedModels?.length > 0 && <p className="text-xs text-text-muted">上游返回模型：{detail.reportedModels.join("、")}</p>}{detail?.prompt && <p className="whitespace-pre-wrap text-sm">{detail.prompt}</p>}{detail?.error && <p className="whitespace-pre-wrap break-words text-sm text-red-600">{detail.error}</p>}
          <CodexTrialOutput key={detail?.runId} result={detail} text={detail?.output || formatTrialLog(detail?.log)} now={now} className="h-[45vh] rounded-xl" />
          {detail?.log && <details><summary className="cursor-pointer text-xs text-text-muted">原始 CLI 日志</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-surface-2 p-4 text-xs leading-5">{detail.log}</pre></details>}
        </div>}
    </Modal>
  </div>;
}
