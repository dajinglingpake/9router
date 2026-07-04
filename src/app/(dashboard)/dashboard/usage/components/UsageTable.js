"use client";

import { useState, useEffect, useCallback, useMemo, Fragment } from "react";
import PropTypes from "prop-types";
import Card from "@/shared/components/Card";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;
const fmtPercent = (value, total) => {
  if (!total || !value) return "0%";
  const percent = (value / total) * 100;
  if (percent > 0 && percent < 0.1) return "<0.1%";
  if (percent >= 10 || Number.isInteger(percent)) return `${percent.toFixed(0)}%`;
  return `${percent.toFixed(1)}%`;
};

function getUsageValue(item, viewMode) {
  if (viewMode === "tokens") {
    return item.totalTokens ?? ((item.promptTokens || 0) + (item.completionTokens || 0));
  }
  return item.totalCost ?? item.cost ?? 0;
}

function readExpandedGroups(storageKey) {
  if (typeof window === "undefined") return new Set();

  try {
    const saved = window.localStorage.getItem(storageKey);
    return saved ? new Set(JSON.parse(saved)) : new Set();
  } catch (e) {
    console.error(`Failed to load ${storageKey}:`, e);
    return new Set();
  }
}

function fmtTime(iso) {
  if (!iso) return "Never";
  const diffMins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function SortIcon({ field, currentSort, currentOrder }) {
  if (currentSort !== field) return <span className="ml-1 opacity-20">↕</span>;
  return <span className="ml-1">{currentOrder === "asc" ? "↑" : "↓"}</span>;
}

SortIcon.propTypes = {
  field: PropTypes.string.isRequired,
  currentSort: PropTypes.string.isRequired,
  currentOrder: PropTypes.string.isRequired,
};

/**
 * Render 3 token or cost cells based on viewMode
 */
function ValueCells({ item, viewMode, isSummary = false }) {
  if (viewMode === "tokens") {
    return (
      <>
        <td className="px-6 py-3 text-right text-text-muted">
          {isSummary && item.promptTokens === undefined ? "—" : fmt(item.promptTokens)}
        </td>
        <td className="px-6 py-3 text-right text-text-muted">
          {item.cachedTokens ? fmt(item.cachedTokens) : "—"}
        </td>
        <td className="px-6 py-3 text-right text-text-muted">
          {isSummary && item.completionTokens === undefined ? "—" : fmt(item.completionTokens)}
        </td>
        <td className="px-6 py-3 text-right font-medium">
          {fmt(item.totalTokens)}
        </td>
      </>
    );
  }
  return (
    <>
      <td className="px-6 py-3 text-right text-text-muted">
        {isSummary && item.inputCost === undefined ? "—" : fmtCost(item.inputCost)}
      </td>
      <td className="px-6 py-3 text-right text-text-muted">
        {item.cachedCost ? fmtCost(item.cachedCost) : "—"}
      </td>
      <td className="px-6 py-3 text-right text-text-muted">
        {isSummary && item.outputCost === undefined ? "—" : fmtCost(item.outputCost)}
      </td>
      <td className="px-6 py-3 text-right font-medium text-warning">
        {fmtCost(item.totalCost ?? item.cost)}
      </td>
    </>
  );
}

ValueCells.propTypes = {
  item: PropTypes.object.isRequired,
  viewMode: PropTypes.string.isRequired,
  isSummary: PropTypes.bool,
};

function ShareCell({ item, totalUsage, viewMode }) {
  return (
    <td className="px-6 py-3 text-right font-medium text-text-muted tabular-nums">
      {fmtPercent(getUsageValue(item, viewMode), totalUsage)}
    </td>
  );
}

ShareCell.propTypes = {
  item: PropTypes.object.isRequired,
  totalUsage: PropTypes.number.isRequired,
  viewMode: PropTypes.string.isRequired,
};

/**
 * Reusable sortable usage table with expandable group rows.
 *
 * @param {object} props
 * @param {string} props.title - Table title
 * @param {Array} props.columns - Column definitions [{field, label}]
 * @param {Array} props.groupedData - Grouped data from groupDataByKey
 * @param {string} props.tableType - Table type key for sort URL params
 * @param {string} props.sortBy - Current sort field
 * @param {string} props.sortOrder - Current sort order
 * @param {function} props.onToggleSort - Sort toggle handler
 * @param {string} props.viewMode - "tokens" or "costs"
 * @param {string} props.storageKey - localStorage key for expanded state
 * @param {function} props.renderGroupLabel - Render group summary first cell content
 * @param {function} props.renderDetailCells - Render detail row custom cells (before value cells)
 * @param {function} props.renderSummaryCells - Render summary row cells after group label (placeholder cols)
 * @param {string} props.emptyMessage - Empty state message
 */
export default function UsageTable({
  title,
  columns,
  groupedData,
  tableType,
  sortBy,
  sortOrder,
  onToggleSort,
  viewMode,
  storageKey,
  renderDetailCells,
  renderSummaryCells,
  emptyMessage,
}) {
  const [expanded, setExpanded] = useState(() => readExpandedGroups(storageKey));

  // Save expanded state to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify([...expanded]));
    } catch (e) {
      console.error(`Failed to save ${storageKey}:`, e);
    }
  }, [expanded, storageKey]);

  const toggleGroup = useCallback((groupKey) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(groupKey) ? next.delete(groupKey) : next.add(groupKey);
      return next;
    });
  }, []);

  const valueColumns = useMemo(() => {
    if (viewMode === "tokens") {
      return [
        { field: "promptTokens", label: "Input Tokens" },
        { field: "cachedTokens", label: "Cached" },
        { field: "completionTokens", label: "Output Tokens" },
        { field: "totalTokens", label: "Total Tokens" },
      ];
    }
    return [
      { field: "inputCost", label: "Input Cost" },
      { field: "cachedCost", label: "Cached Cost" },
      { field: "outputCost", label: "Output Cost" },
      { field: "totalCost", label: "Total Cost" },
    ];
  }, [viewMode]);

  const shareSortField = "usageShare";

  const totalUsage = useMemo(
    () => groupedData.reduce((sum, group) => sum + getUsageValue(group.summary, viewMode), 0),
    [groupedData, viewMode]
  );

  const totalColSpan = columns.length + valueColumns.length + 1;

  return (
    <Card className="overflow-hidden">
      <div className="p-4 border-b border-border bg-bg-subtle/50">
        <h3 className="font-semibold">{title}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead className="bg-bg-subtle/30 text-text-muted uppercase text-xs">
            <tr>
              {columns.map((col) => (
                <th
                  key={col.field}
                  className={`px-6 py-3 cursor-pointer hover:bg-bg-subtle/50 ${col.align === "right" ? "text-right" : ""}`}
                  onClick={() => onToggleSort(tableType, col.field)}
                >
                  {col.label}{" "}
                  <SortIcon field={col.field} currentSort={sortBy} currentOrder={sortOrder} />
                </th>
              ))}
              {valueColumns.map((col) => (
                <th
                  key={col.field}
                  className="px-6 py-3 text-right cursor-pointer hover:bg-bg-subtle/50"
                  onClick={() => onToggleSort(tableType, col.field)}
                >
                  {col.label}{" "}
                  <SortIcon field={col.field} currentSort={sortBy} currentOrder={sortOrder} />
                </th>
              ))}
              <th
                className="px-6 py-3 text-right cursor-pointer hover:bg-bg-subtle/50"
                onClick={() => onToggleSort(tableType, shareSortField)}
              >
                占比{" "}
                <SortIcon field={shareSortField} currentSort={sortBy} currentOrder={sortOrder} />
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {groupedData.map((group) => {
              const isExpandable = group.items.length > 1;

              return (
              <Fragment key={`${viewMode}:${group.groupKey}`}>
                {/* Group summary row */}
                <tr
                  className={`group-summary transition-colors ${isExpandable ? "cursor-pointer hover:bg-bg-subtle/50" : "hover:bg-bg-subtle/20"}`}
                  onClick={isExpandable ? () => toggleGroup(group.groupKey) : undefined}
                >
                  <td className="px-6 py-3">
                    <div className="flex items-center gap-2">
                      {isExpandable ? (
                        <span className={`material-symbols-outlined text-[18px] text-text-muted transition-transform ${expanded.has(group.groupKey) ? "rotate-90" : ""}`}>
                          chevron_right
                        </span>
                      ) : (
                        <span className="inline-block w-[18px]" aria-hidden="true" />
                      )}
                      <span className={`font-medium transition-colors ${group.summary.pending > 0 ? "text-primary" : ""}`}>
                        {group.groupKey}
                      </span>
                    </div>
                  </td>
                  {renderSummaryCells(group)}
                  <ValueCells item={group.summary} viewMode={viewMode} isSummary />
                  <ShareCell item={group.summary} totalUsage={totalUsage} viewMode={viewMode} />
                </tr>
                {/* Detail rows */}
                {isExpandable && expanded.has(group.groupKey) && group.items.map((item) => (
                  <tr
                    key={`${viewMode}:detail-${item.key}`}
                    className="group-detail hover:bg-bg-subtle/20 transition-colors"
                  >
                    {renderDetailCells(item)}
                    <ValueCells item={item} viewMode={viewMode} />
                    <ShareCell item={item} totalUsage={totalUsage} viewMode={viewMode} />
                  </tr>
                ))}
              </Fragment>
              );
            })}
            {groupedData.length === 0 && (
              <tr>
                <td colSpan={totalColSpan} className="px-6 py-8 text-center text-text-muted">
                  {emptyMessage}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

UsageTable.propTypes = {
  title: PropTypes.string.isRequired,
  columns: PropTypes.arrayOf(PropTypes.shape({
    field: PropTypes.string.isRequired,
    label: PropTypes.string.isRequired,
    align: PropTypes.string,
  })).isRequired,
  groupedData: PropTypes.array.isRequired,
  tableType: PropTypes.string.isRequired,
  sortBy: PropTypes.string.isRequired,
  sortOrder: PropTypes.string.isRequired,
  onToggleSort: PropTypes.func.isRequired,
  viewMode: PropTypes.string.isRequired,
  storageKey: PropTypes.string.isRequired,
  renderDetailCells: PropTypes.func.isRequired,
  renderSummaryCells: PropTypes.func.isRequired,
  emptyMessage: PropTypes.string.isRequired,
};

// Re-export utilities for use in UsageStats orchestrator
export { fmt, fmtCost, fmtTime };
