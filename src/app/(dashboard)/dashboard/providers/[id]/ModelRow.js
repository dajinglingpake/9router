import { useId, useState } from "react";
import PropTypes from "prop-types";
import { CapacityBadges } from "@/shared/components";
import { translate } from "@/i18n/runtime";

export default function ModelRow({ model, fullModel, alias, copied, onCopy, testStatus, availability, showTestDetails, isCustom, isFree, freeTierUrl, onDeleteAlias, onTest, isTesting, testDisabled, onDisable, caps, thinkingSuffix }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const displayModel = thinkingSuffix ? `${fullModel}(${thinkingSuffix})` : fullModel;
  const hasDetails = showTestDetails && availability && (availability.error || availability.testedAt || Number.isFinite(availability.latencyMs) || alias);
  const StatusLabel = hasDetails ? "button" : "span";
  const borderColor = testStatus === "ok"
    ? "border-green-500/40"
    : testStatus === "error"
    ? "border-red-500/40"
    : "border-border";

  const iconColor = testStatus === "ok"
    ? "#22c55e"
    : testStatus === "error"
    ? "#ef4444"
    : undefined;

  return (
    <div className={`group w-full sm:w-auto min-w-0 max-w-full rounded-lg border px-3 py-2 ${borderColor} hover:bg-sidebar/50`}>
      <div className="flex min-w-0 items-start gap-2 sm:items-center">
        <span
          className="material-symbols-outlined shrink-0 text-base mt-0.5 sm:mt-0"
          style={iconColor ? { color: iconColor } : undefined}
        >
          {testStatus === "ok" ? "check_circle" : testStatus === "error" ? "cancel" : testStatus === "retry" ? "schedule" : "smart_toy"}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <code title={displayModel} className="w-fit max-w-full break-all rounded bg-sidebar px-1.5 py-0.5 font-mono text-xs text-text-muted sm:max-w-[360px] sm:truncate">{displayModel}</code>
          <span className="flex min-w-0 items-center text-[9px] gap-1 pl-1">
            {availability && <StatusLabel
              className={`shrink-0 ${testStatus === "ok" ? "text-green-600 dark:text-green-400" : testStatus === "error" ? "text-red-500" : "text-text-muted"} ${hasDetails ? "underline decoration-dotted underline-offset-2" : ""}`}
              title={availability.error || (availability.testedAt ? `检测时间：${new Date(availability.testedAt).toLocaleString()}` : undefined)}
              {...(hasDetails && { type: "button", "aria-label": `查看 ${model.id} 检测详情`, "aria-expanded": detailsOpen,
                "aria-controls": detailsOpen ? detailsId : undefined, onClick: () => setDetailsOpen(open => !open) })}
            >
              {isTesting ? "检测中" : testStatus === "ok" ? "可用" : testStatus === "error" ? "检测失败" : testStatus === "retry" ? "待重试" : "未检测"}
            </StatusLabel>}
            {model.name && <span className="break-all sm:truncate text-[9px] italic text-text-muted/70">{model.name}</span>}
            {isFree && (freeTierUrl
              ? <a className="text-green-600 hover:underline dark:text-green-400" href={freeTierUrl} target="_blank" rel="noopener noreferrer"
                  title={model.freeTierCheckedAt ? `免费层核对时间 ${new Date(model.freeTierCheckedAt).toLocaleString()}` : "查看官方定价"}>{translate("Free")}</a>
              : <span className="text-green-600 dark:text-green-400">{translate("Free")}</span>)}
            <CapacityBadges caps={caps} colorOverride="text-text-muted/70" size={12} />
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
          {onTest && (
            <div className="relative shrink-0 group/btn">
              <button
                onClick={onTest}
                disabled={isTesting || testDisabled}
                aria-label={`Test ${model.id}`}
                className={`rounded p-0.5 text-text-muted transition-opacity hover:bg-sidebar hover:text-primary focus-visible:opacity-100 disabled:cursor-not-allowed disabled:text-text-muted/40 ${isTesting || availability ? "opacity-100" : "opacity-100 sm:opacity-0 sm:group-hover:opacity-100"}`}
              >
                <span className="material-symbols-outlined text-sm" style={isTesting ? { animation: "spin 1s linear infinite" } : undefined}>
                  {isTesting ? "progress_activity" : "science"}
                </span>
              </button>
              <span className="pointer-events-none absolute mt-1 top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
                {isTesting ? "Testing..." : "Test"}
              </span>
            </div>
          )}
          <div className="relative shrink-0 group/btn">
            <button
              onClick={() => onCopy(displayModel, `model-${model.id}`)}
              aria-label={`${translate("Copy")} ${displayModel}`}
              className="rounded p-0.5 text-text-muted hover:bg-sidebar hover:text-primary"
            >
              <span className="material-symbols-outlined text-sm">
                {copied === `model-${model.id}` ? "check" : "content_copy"}
              </span>
            </button>
            <span className="pointer-events-none absolute mt-1 top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
              {copied === `model-${model.id}` ? "Copied!" : "Copy"}
            </span>
          </div>
          {isCustom ? (
            <button
              onClick={onDeleteAlias}
              className="rounded p-0.5 text-text-muted opacity-100 transition-opacity hover:bg-red-500/10 hover:text-red-500 sm:opacity-0 sm:group-hover:opacity-100"
              title="Remove custom model"
            >
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
          ) : onDisable ? (
            <button
              onClick={onDisable}
              className="rounded p-0.5 text-text-muted opacity-100 transition-opacity hover:bg-red-500/10 hover:text-red-500 sm:opacity-0 sm:group-hover:opacity-100"
              title="Disable this model"
            >
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
          ) : null}
        </div>
      </div>
      {hasDetails && detailsOpen && <div id={detailsId} className="mt-2 max-w-sm space-y-1 break-words border-t border-border-subtle pt-2 text-xs text-text-muted">
        {availability.error && <p className="text-text-main">{availability.error}</p>}
        {Number.isFinite(availability.latencyMs) && <p>耗时 {(availability.latencyMs / 1000).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 秒</p>}
        {availability.testedAt && <p>检测于 {new Date(availability.testedAt).toLocaleString("zh-CN", { hour12: false })}</p>}
        {alias && <p>别名 {alias}</p>}
      </div>}
    </div>
  );
}

ModelRow.propTypes = {
  model: PropTypes.shape({
    id: PropTypes.string.isRequired,
  }).isRequired,
  fullModel: PropTypes.string.isRequired,
  alias: PropTypes.string,
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  testStatus: PropTypes.oneOf(["ok", "error", "retry"]),
  availability: PropTypes.object,
  showTestDetails: PropTypes.bool,
  isCustom: PropTypes.bool,
  isFree: PropTypes.bool,
  freeTierUrl: PropTypes.string,
  onDeleteAlias: PropTypes.func,
  onTest: PropTypes.func,
  isTesting: PropTypes.bool,
  testDisabled: PropTypes.bool,
  onDisable: PropTypes.func,
  caps: PropTypes.object,
  thinkingSuffix: PropTypes.string,
};
