"use client";

import { useMemo, useState } from "react";
import { ACCOUNT_PERFORMANCE_RULES, classifyAccountPerformance } from "@/shared/utils/accountPerformance.js";
import { duration, formatNumber, percent, throughput, tokenCount, Icon } from "./format";
import DiagnosticsIdentity from "./DiagnosticsIdentity";
import { AccountOfficialStatus } from "./OfficialStatus";

const stabilityLabels = { stable: "较稳定", errors: "失败偏多", insufficient: "样本不足", inactive: "近期无记录", empty: "暂无样本", "no-success": "近期未成功" };
const colors = {
  stable: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  fast: "bg-sky-50 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300",
  slow: "bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  overload: "bg-red-50 text-red-800 dark:bg-red-950/50 dark:text-red-300",
  muted: "bg-surface-2 text-text-muted",
};
const columns = "lg:grid-cols-[minmax(0,2fr)_minmax(100px,.9fr)_minmax(145px,1.2fr)_minmax(90px,.8fr)_minmax(130px,1.1fr)]";
const timestamp = value => value == null ? "未记录成功" : new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const matches = (account, filter) => filter === "all" || (filter === "stable" ? account.stability === "stable"
  : filter === "fast" ? account.speedCandidate : filter === "slow" ? account.waitingStatus === "slow" : filter === "overload" ? account.frequentOverload
    : ["insufficient", "inactive", "empty", "no-success"].includes(account.stability));
const Badge = ({ tone, children }) => <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${colors[tone]}`}>{children}</span>;

export default function DiagnosticsAccounts({ performance, range, loading, onFocusAccount, onShowOverload, onShowFailures }) {
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("fast");
  const [waitingMs, setWaitingMs] = useState(ACCOUNT_PERFORMANCE_RULES.waitingMs);
  const accounts = useMemo(() => (performance?.accounts || []).map(account => ({ ...account, ...classifyAccountPerformance(account, waitingMs) })), [performance, waitingMs]);
  const rows = useMemo(() => accounts.filter(account => matches(account, filter)).sort((a, b) => {
    if (sort === "fast") {
      const priority = account => account.throughputSamples < ACCOUNT_PERFORMANCE_RULES.minSpeedSamples ? 1 : 0;
      return priority(a) - priority(b) || Number(b.speedCandidate) - Number(a.speedCandidate)
        || (b.throughputMeanTps ?? -1) - (a.throughputMeanTps ?? -1) || b.throughputSamples - a.throughputSamples;
    }
    if (sort === "waiting") return (b.ttftP95Ms ?? -1) - (a.ttftP95Ms ?? -1);
    if (sort === "overload") return b.overloadCount - a.overloadCount || (b.overloadRate ?? -1) - (a.overloadRate ?? -1);
    const priority = account => account.stability === "stable" ? 0 : ["inactive", "empty"].includes(account.stability) ? 2 : 1;
    return priority(a) - priority(b) || (a.errorRate ?? 101) - (b.errorRate ?? 101) || b.successCount - a.successCount;
  }), [accounts, filter, sort]);
  if (!performance) return null;
  const rules = performance.rules;
  const filters = [{ id: "all", label: "全部账号", icon: "account_circle", tone: "muted" },
    { id: "fast", label: "全程吞吐较高", icon: "bolt", tone: "fast" },
    { id: "stable", label: "较稳定", icon: "check_circle", tone: "stable" },
    { id: "slow", label: "等待偏慢", icon: "schedule", tone: "slow" },
    { id: "overload", label: "频繁过载", icon: "report", tone: "overload" },
    { id: "uncertain", label: "待观察", icon: "help", tone: "muted" }];

  return <section aria-label="账号表现概览" aria-busy={loading} className={`min-w-0 overflow-hidden rounded-2xl border border-border bg-surface shadow-[var(--shadow-soft)] ${loading ? "opacity-60" : ""}`}>
    <div className="flex flex-wrap items-start justify-between gap-3 p-5 pb-4">
      <div><h2 className="text-base font-semibold">账号表现概览</h2><p className="mt-1 text-xs leading-5 text-text-muted">按成功尝试的输出 token ÷ 日志总耗时比较吞吐；失败和过载单独显示。</p></div>
      <label className="flex items-center gap-2 text-xs text-text-muted">等待偏慢阈值
        <select aria-label="账号等待偏慢阈值" value={waitingMs} onChange={event => setWaitingMs(Number(event.target.value))} className="min-h-11 rounded-lg border border-border bg-surface px-3 text-sm text-text-main outline-none focus-visible:ring-2 focus-visible:ring-primary">
          {[30000, 60000, 120000].map(value => <option key={value} value={value}>等待 P95 ≥ {value / 1000}s</option>)}
        </select>
      </label>
    </div>
    <div className="flex flex-wrap gap-2 px-5 pb-4" aria-label="账号表现分类">
      {filters.map(item => <button key={item.id} type="button" aria-pressed={filter === item.id} disabled={item.id === "fast" && performance.model === "all"} title={item.id === "fast" && performance.model === "all" ? "请在上方选择具体模型后比较速度" : undefined} onClick={() => { setFilter(item.id); if (item.id === "fast") setSort("fast"); }} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-60 ${filter === item.id ? "border-primary ring-1 ring-primary/20" : "border-transparent hover:border-border"} ${colors[item.tone]}`}>
        <Icon className="text-[18px]">{item.icon}</Icon><span>{item.label}</span><strong className="tabular-nums">{item.id === "fast" && performance.model === "all" ? "—" : formatNumber(accounts.filter(account => matches(account, item.id)).length)}</strong>
      </button>)}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle bg-surface-2/40 px-5 py-2">
      <p className="text-xs leading-5 text-text-muted">仅评价所选时段日志 · 统计截止 {timestamp(performance.observedUntil)} · 账号可复制或仅关注</p>
      <label className="flex items-center gap-2 text-xs text-text-muted">排序<select aria-label="账号表现排序" value={sort} onChange={event => setSort(event.target.value)} className="min-h-11 rounded-lg border border-border bg-surface px-2 text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        <option value="fast">平均全程吞吐最高</option><option value="stable">较稳定优先</option><option value="waiting">等待 P95 最长优先</option><option value="overload">过载最多优先</option>
      </select></label>
    </div>
    <p className="border-t border-border-subtle px-5 py-3 text-xs leading-5 text-text-muted">{performance.model === "all" ? "请选择具体模型后比较吞吐；全部模型为混合统计。" : `当前比较 ${performance.model}；Codex/OpenAI 总输出含思考 token，非思考部分另列。`} 含账号执行期间的思考和等待，不含此前排队、失败重试及客户端网络；吞吐不代表质量评分。</p>
    <div className={`hidden gap-4 px-5 py-3 text-xs text-text-muted lg:grid ${columns}`} aria-hidden="true"><span>账号 / 表现</span><span>成功 / 失败尝试</span><span>全程输出吞吐</span><span>上游过载</span><span>成功 token 用量</span></div>
    <ul className="divide-y divide-border-subtle border-t border-border-subtle">
      {rows.map(account => <li key={account.id} className={`grid min-w-0 grid-cols-3 items-center gap-x-4 gap-y-3 px-5 py-4 transition-colors hover:bg-surface-2/40 ${columns}`}>
        <div className="col-span-3 min-w-0 lg:col-span-1">
          <DiagnosticsIdentity name={account.name} connection={account} onFocus={() => onFocusAccount(account, "byAccount")} />
          <div className="flex flex-wrap items-center gap-1.5">
            {account.speedCandidate && <Badge tone="fast">{account.recentSuccess ? "吞吐较高" : "历史吞吐较高"}{account.speedLimitedSample ? " · 样本少" : ""}</Badge>}
            <Badge tone={account.stability === "stable" ? "stable" : account.stability === "errors" ? "overload" : "muted"}>{stabilityLabels[account.stability]}</Badge>
            {account.waitingStatus === "slow" && <Badge tone="slow">等待偏慢</Badge>}
            {account.frequentOverload && <Badge tone="overload">频繁过载</Badge>}
          </div>
          {account.speedCandidate && <p className="mt-1 text-xs leading-5 text-sky-800 dark:text-sky-300">平均吞吐比 {account.speedPeerAccounts} 个同提供商同模型账号的中位值高 {percent(account.speedFasterPercent)}</p>}
          {account.bindings.length > 0 && <p className="mt-1 truncate text-xs text-primary" title={account.bindings.join("、")}>专用：{account.bindings.join("、")}</p>}
          <p className="mt-1 text-xs leading-5 text-text-muted">最后成功 {timestamp(account.lastSuccessAt)}</p>
          {account.providers?.length === 1 && <AccountOfficialStatus provider={account.providers[0]} start={range?.start} end={range?.end} windowLabel="所选时段" />}
        </div>
        <div className="min-w-0 text-sm tabular-nums">
          <p className="mb-1 text-xs text-text-muted lg:sr-only">成功 / 失败尝试</p>
          <span className="font-medium text-emerald-800 dark:text-emerald-300">{formatNumber(account.successCount)}</span><span className="mx-1 text-text-muted">/</span><button type="button" aria-label={`查看 ${account.name} 的失败尝试`} onClick={() => onShowFailures(account)} className={`min-h-11 min-w-11 cursor-pointer underline decoration-dotted underline-offset-4 lg:min-h-9 lg:min-w-0 ${account.failureCount ? "text-danger" : "text-text-muted"}`}>{formatNumber(account.failureCount)}</button>
          <p className="text-xs leading-5 text-text-muted">异常占比 {percent(account.errorRate)}</p>
        </div>
        <div className="min-w-0 text-sm tabular-nums">
          <p className="mb-1 text-xs text-text-muted lg:sr-only">全程输出吞吐</p>
          <span className={`font-medium ${account.speedCandidate ? "text-sky-800 dark:text-sky-300" : ""}`}>{throughput(account.throughputMeanTps)}</span>
          <p className="mt-1 text-xs leading-5 text-text-muted">中位 {throughput(account.throughputP50Tps)}</p>
          <p className="mt-1 text-xs leading-5 text-text-muted">{formatNumber(account.throughputSamples)} 次有效记录{account.throughputSamples < rules.minSpeedSamples ? " · 不足" : ""}</p>
          <p className={`mt-1 text-xs leading-5 ${account.waitingStatus === "slow" ? "text-amber-800 dark:text-amber-300" : "text-text-muted"}`}>等待 P95 {duration(account.ttftP95Ms)}</p>
        </div>
        <div className="min-w-0 text-sm tabular-nums">
          <p className="mb-1 text-xs text-text-muted lg:sr-only">上游过载</p>
          <button type="button" aria-label={`查看 ${account.name} 的过载报告`} onClick={() => onShowOverload(account)} className={`min-h-11 min-w-11 cursor-pointer font-medium underline decoration-dotted underline-offset-4 lg:min-h-9 lg:min-w-0 ${account.frequentOverload ? "text-danger" : "text-text-main"}`}>{formatNumber(account.overloadCount)} 次</button>
          <p className="text-xs leading-5 text-text-muted">占比 {percent(account.overloadRate)}</p>
        </div>
        <div className="col-span-3 border-t border-border-subtle pt-3 text-xs leading-5 text-text-muted lg:col-span-1 lg:border-0 lg:pt-0">
          <p>输出 P50 <span className="font-medium tabular-nums text-text-main">{tokenCount(account.outputTokensP50)}</span> token</p>
          <p>思考 P50 {tokenCount(account.reasoningTokensP50)} <span className="text-text-muted">({formatNumber(account.reasoningTokenSamples)} 次)</span></p>
          <p>非思考全程 {throughput(account.nonReasoningThroughputMeanTps)} <span>({formatNumber(account.nonReasoningThroughputSamples)} 次)</span></p>
          <p>输入 P50 {tokenCount(account.inputTokensP50)} token</p>
        </div>
      </li>)}
    </ul>
    {!rows.length && <p role="status" className="px-5 py-8 text-center text-sm text-text-muted">{filter === "fast" && performance.model === "all" ? "请先在上方选择具体模型，再比较全程输出吞吐。" : "所选时段没有符合此分类的账号，可以切换“全部账号”或扩大时间范围。"}</p>}
    <details className="border-t border-border-subtle px-5 py-3 text-xs leading-6 text-text-muted">
      <summary className="w-fit cursor-pointer font-medium">分类规则 <span className="ml-2 font-normal">按已保留日志判断，不代表实时可用性</span></summary>
      <div className="mt-2 grid gap-2 lg:grid-cols-2">
        <p className="lg:col-span-2">全程吞吐较高：选择具体模型后，至少 {rules.minSpeedSamples} 次有效成功记录；同一时段、同提供商同模型的其他账号中，至少 {rules.minSpeedPeers} 个账号各有 {rules.minSpeedSamples} 次记录，当前账号的平均吞吐比其他账号平均吞吐的中位值至少高 {rules.fasterPercent}%。不足 {rules.reliableSpeedSamples} 次标为“样本少”。历史表现仍参与筛选，并保留最后成功时间和“近期无记录”等标签，不保证当前可用。过载不会取消吞吐候选标签。仅关注某账号或 Key 时，对照仍取其他账号在该时段的全部调用。</p>
        <p className="lg:col-span-2">单次吞吐 = 输出 token ÷ 日志总耗时（秒）；账号平均 = 有效记录的输出 token 总量 ÷ 它们的耗时总和，中位数则取每次吞吐的 P50。统计只含成功记录；缺 token、总耗时无效或为 0、明确标为估算的记录不参与。历史估算标记缺失时无法追溯。现有耗时从账号开始执行后计起，含执行内思考与等待，不含此前账号排队、失败重试或客户端网络；不能用于判断开始输出后的纯生成速度。</p>
        <p className="lg:col-span-2">Codex/OpenAI 总输出 token 包含思考、工具和部分不可见格式 token，不能当作最终文字长度。在思考用量已记录且不超过总输出时，另列（总输出 − 思考 token）÷ 总耗时；此值也包含工具和格式开销。非思考速度只使用能拆分的样本，不把缺失思考量当成 0。输入长度和思考强度未对齐，吞吐不能直接作为质量评分。<a className="ml-1 text-primary hover:underline" href="https://developers.openai.com/api/docs/guides/token-counting#understand-output-token-counts" target="_blank" rel="noopener noreferrer">OpenAI 官方 token 口径</a></p>
        <p>较稳定：至少 {rules.minAttempts} 条成功与失败尝试，异常占比 ≤ {rules.stableErrorRate}%，且统计截止前 1 小时内有成功记录；短于 1 小时的查询使用整个时段。较稳定不代表响应快。无近期记录、近期未成功或样本不足的账号列入“待观察”，不会标为正常。</p>
        <p>等待偏慢：至少 {rules.minWaitingSamples} 个成功开始响应样本，等待 P95 ≥ 所选阈值。P95 表示 95% 的样本不超过此值。Codex 计时含预读与模型思考，不能据此归因为过载，也不把较长输出直接判为等待慢。</p>
        <p>频繁过载：所选时段至少 {rules.minOverloads} 次上游明确过载，且占成功与失败尝试的比例 ≥ {rules.frequentOverloadRate}%。所有过载仍显示次数，低于分类阈值不代表没有过载。</p>
        <p>分类可重叠；异常和过载占比按日志尝试计算，不是调用最终失败率。近期判断以所选时段的结束时间为上限；已清空日志无法补算，样本多也不能保证覆盖完整。</p>
      </div>
    </details>
  </section>;
}
