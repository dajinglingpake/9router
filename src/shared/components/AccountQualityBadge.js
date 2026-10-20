import { getAccountQualityLabel, getAccountQualityColor, getAccountQualityTextColor, getAccountQualityMarkedAt } from "@/shared/utils/accountQuality.js";

export default function AccountQualityBadge({ connection }) {
  const label = getAccountQualityLabel(connection);
  if (!label) return null;
  const color = getAccountQualityColor(connection);
  const markedAt = getAccountQualityMarkedAt(connection);
  const title = markedAt ? `${label} · 标记于 ${new Date(markedAt).toLocaleString("zh-CN", { hour12: false })}` : label;
  return <span translate="no" data-account-quality-label title={title} className="notranslate my-1 inline-block max-w-full select-text whitespace-pre-wrap break-words rounded-lg px-2.5 py-1.5 text-xs font-semibold leading-5 ring-1 ring-inset ring-black/15 [overflow-wrap:anywhere] dark:ring-white/25" style={{ backgroundColor: color, color: getAccountQualityTextColor(color) }}>{label}</span>;
}
