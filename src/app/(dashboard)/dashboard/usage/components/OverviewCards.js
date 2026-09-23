"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;

function sumStats(stats, field) {
  const source = Object.keys(stats.byProvider || {}).length ? stats.byProvider : stats.byModel;
  return Object.values(source || {}).reduce((sum, item) => sum + (item?.[field] || 0), 0);
}

export default function OverviewCards({ stats }) {
  const totalRequests = stats.totalRequests || sumStats(stats, "requests");
  const totalPromptTokens = stats.totalPromptTokens || sumStats(stats, "promptTokens");
  const totalCompletionTokens = stats.totalCompletionTokens || sumStats(stats, "completionTokens");
  const totalCost = stats.totalCost || sumStats(stats, "cost");

  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 sm:gap-4">
      <Card className="flex min-w-0 flex-col items-center text-center gap-1 px-3 py-3 sm:px-4">
        <span className="text-text-muted text-xs uppercase font-semibold sm:text-sm">Total Requests</span>
        <span className="w-full truncate text-lg font-bold xl:text-xl" title={fmt(totalRequests)}>{fmt(totalRequests)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col items-center text-center gap-1 px-3 py-3 sm:px-4">
        <span className="text-text-muted text-xs uppercase font-semibold sm:text-sm">Total Input Tokens</span>
        <span className="w-full truncate text-lg font-bold text-primary xl:text-xl" title={fmt(totalPromptTokens)}>{fmt(totalPromptTokens)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col items-center text-center gap-1 px-3 py-3 sm:px-4">
        <span className="text-text-muted text-xs uppercase font-semibold sm:text-sm">Cached Tokens</span>
        <span className="w-full truncate text-lg font-bold text-info xl:text-xl" title={fmt(stats.totalCachedTokens)}>{fmt(stats.totalCachedTokens)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col items-center text-center gap-1 px-3 py-3 sm:px-4">
        <span className="text-text-muted text-xs uppercase font-semibold sm:text-sm">Output Tokens</span>
        <span className="w-full truncate text-lg font-bold text-success xl:text-xl" title={fmt(totalCompletionTokens)}>{fmt(totalCompletionTokens)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col items-center text-center gap-1 px-3 py-3 sm:px-4">
        <span className="text-text-muted text-xs uppercase font-semibold sm:text-sm">Est. Cost</span>
        <span className="w-full truncate text-lg font-bold text-warning xl:text-xl" title={`~${fmtCost(totalCost)}`}>~{fmtCost(totalCost)}</span>
        <span className="text-[10px] text-text-muted">Estimated, not actual billing</span>
      </Card>
    </div>
  );
}

OverviewCards.propTypes = {
  stats: PropTypes.object.isRequired,
};
