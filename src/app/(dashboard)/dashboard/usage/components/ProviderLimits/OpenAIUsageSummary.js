const formatNumber = value => value.toLocaleString(undefined, { maximumFractionDigits: 4 });
const formatMoney = (amount, currency) => `${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${currency}`;
const componentLabels = { input: "普通输入", cached: "缓存读取", write30m: "缓存写入（30 分钟）", write12h: "缓存写入（12 小时）", output: "输出" };
const tierLabels = { default: "标准", flex: "Flex", batch: "Batch", priority: "Fast", fast: "Fast", ultrafast: "Ultrafast" };

export default function OpenAIUsageSummary({ usage, detailUrl }) {
  const estimate = usage.costs.length === 0 ? usage.estimate : null;
  const amounts = usage.costs.length ? usage.costs : estimate?.amount != null ? [estimate] : [];
  const amountLabel = estimate ? (estimate.unpricedRequests > 0 ? "本月消费（部分估算）" : "本月消费（估算）") : "本月已消费";
  return (
    <div className="space-y-2">
      <div className="text-[10px] text-text-muted">组织本月统计 · UTC</div>
      <dl className="space-y-px">
        {amounts.map(cost => (
          <div key={cost.currency} className="flex items-center justify-between gap-2 border-b border-black/5 px-1.5 py-1 transition-colors hover:bg-black/[0.02] dark:border-white/5 dark:hover:bg-white/[0.02]">
            <dt className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-text-primary">
              <span className="shrink-0 text-[10px]" aria-hidden="true">💰</span>
              {amountLabel}
            </dt>
            <dd className="shrink-0 text-xs font-medium tabular-nums text-blue-600 dark:text-blue-400">{formatMoney(cost.amount, cost.currency)}</dd>
          </div>
        ))}
      </dl>
      <details className="px-1.5 text-[10px] text-text-muted">
        <summary className="cursor-pointer hover:text-text-primary">{estimate ? "估算依据与用量明细" : "用量明细"}</summary>
        <div className="mt-2 space-y-2">
          <p>{usage.periodStart.slice(0, 10)} — {usage.periodEnd.slice(0, 16).replace("T", " ")} UTC</p>
          <p>{formatNumber(usage.requests)} 次模型请求 · 输入 {formatNumber(usage.inputTokens)} Token · 输出 {formatNumber(usage.outputTokens)} Token</p>
          {estimate?.breakdown.map(group => (
            <div key={`${group.model}-${group.tier}`} className="space-y-1 border-t border-black/5 pt-1 dark:border-white/5">
              <div className="flex flex-wrap justify-between gap-1 font-medium text-text-primary">
                <span className="break-all">{group.model} · {tierLabels[group.tier]}</span>
                <span className="tabular-nums">{formatMoney(group.amount, estimate.currency)}</span>
              </div>
              {group.components.filter(part => part.tokens > 0).map(part => (
                <div key={part.type} className="flex flex-wrap justify-between gap-1">
                  <span>{componentLabels[part.type]}：{formatNumber(part.tokens)} × ${formatNumber(part.rate)} / 百万</span>
                  <span className="tabular-nums">${formatNumber(part.amount)}</span>
                </div>
              ))}
            </div>
          ))}
          {estimate && <p>按模型、服务档位和缓存用量估算，仅含模型生成费用。采用短上下文单价；长上下文加价、工具费和账单调整未计入，以官方账单为准。</p>}
          {estimate?.unpricedRequests > 0 && <p>另有 {formatNumber(estimate.unpricedRequests)} 次请求因缺少适用单价或用量明细，未计入估算。</p>}
          {estimate && <a href={estimate.pricingUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">查看模型单价</a>}
        </div>
      </details>
      <div className="flex flex-wrap items-center justify-between gap-1 px-1.5 text-[10px] text-text-muted">
        <span>{estimate ? "官方费用暂无记录，金额为估算" : "官方已记录费用 · 可能延迟更新"}</span>
        <a href={detailUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
          官方账单
          <span className="material-symbols-outlined text-[12px]">open_in_new</span>
        </a>
      </div>
    </div>
  );
}
