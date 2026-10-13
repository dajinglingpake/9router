export const formatNumber = value => (value ?? 0).toLocaleString("zh-CN");
export const duration = value => value == null ? "—" : value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;
export const percent = value => value == null ? "—" : `${value.toFixed(1)}%`;
export const throughput = value => value == null ? "—" : `${value.toFixed(1)} tok/s`;
export const tokenCount = value => value == null ? "—" : formatNumber(value);
export const clock = value => new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
export function Icon({ children, className = "" }) {
  return <span aria-hidden="true" className={`material-symbols-outlined text-[20px] ${className}`}>{children}</span>;
}
