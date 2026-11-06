"use client";

const planLabel = plan => ({ plus: "Plus", pro: "Pro", free: "Free", team: "Team", business: "Business", enterprise: "Enterprise", unknown: "套餐未提供" })[plan] || plan;

function QuotaMetric({ title, quota, accountCount }) {
  const known = quota.knownAccounts > 0;
  const color = quota.remainingPercent <= 10 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400";
  return <div className="min-w-0 rounded-xl border border-border-subtle bg-bg p-4">
    <p className="text-sm text-text-muted">{title}</p>
    <p className={`mt-1 text-2xl font-semibold tabular-nums ${known ? color : "text-text-muted"}`}>
      {known ? `${quota.remainingPercent.toFixed(1)}%` : "暂无数据"}
    </p>
    {known && <>
      <p className="mt-1 text-sm text-text-main tabular-nums">约 {quota.equivalentAccounts.toFixed(2)} / {quota.knownAccounts} 个满额账号</p>
      <div role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={quota.remainingPercent}
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-3">
        <div className={quota.remainingPercent <= 10 ? "h-full bg-red-500" : "h-full bg-emerald-500"} style={{ width: `${quota.remainingPercent}%` }} />
      </div>
    </>}
    {quota.accountCount < accountCount && <p className="mt-2 text-xs text-text-muted">此周期适用于 {quota.accountCount} / {accountCount} 个账号</p>}
    {quota.knownAccounts < quota.accountCount && <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">已获取 {quota.knownAccounts} / {quota.accountCount} 个账号，汇总尚不完整</p>}
  </div>;
}

export default function CodexSharedQuotaGroups({ summary }) {
  return <>
    {summary.groups.filter(group => group.scope === "shared").map(group => <section key={group.key} aria-label={`共享额度 · ${planLabel(group.plan)}`} className="mt-4">
      <h3 className="mb-2 text-sm font-medium text-text-main">共享额度 · {planLabel(group.plan)} · {group.accountCount} 个账号<span className="ml-2 text-xs text-text-muted">已耗尽 {group.depletedAccounts} 个</span></h3>
      {group.sharedWeeklyAccounts > 0 && <p className="mb-2 text-xs text-text-muted">{group.sharedWeeklyAccounts === group.accountCount ? "5 小时与每周使用同一份额度。" : `${group.sharedWeeklyAccounts} 个账号的 5 小时额度与周额度共用。`}</p>}
      <div className={`grid grid-cols-1 gap-3 ${group.session.accountCount && group.weekly.accountCount ? "sm:grid-cols-2" : ""}`}>
        {group.session.accountCount > 0 && <QuotaMetric title="5 小时剩余" quota={group.session} accountCount={group.accountCount} />}
        {group.weekly.accountCount > 0 && <QuotaMetric title="每周剩余" quota={group.weekly} accountCount={group.accountCount} />}
      </div>
    </section>)}
    {summary.sharedAccountCount > 0 && <p className="mt-3 text-xs text-text-muted">满额账号为同套餐的等效估算，无法精确换算 Token 或请求次数。此处汇总普通额度。</p>}
  </>;
}
