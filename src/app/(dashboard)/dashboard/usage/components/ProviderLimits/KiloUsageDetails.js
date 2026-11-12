import { formatUsd } from "./utils";

export default function KiloUsageDetails({ usage }) {
  const { daily, warning, detailUrl, freeLimitReference } = usage;
  return (
    <div className="mt-2 space-y-1.5 px-1.5 text-xs text-text-muted">
      {daily && (
        daily.models.length ? (
          <details>
            <summary className="cursor-pointer text-text-primary">
              {daily.date} UTC · {daily.requests} 次请求 · {formatUsd(daily.costUsd)}
            </summary>
            <ul className="mt-1.5 space-y-1">
              {daily.models.map(row => (
                <li key={row.model} className="flex flex-wrap justify-between gap-x-2">
                  <span className="break-all">{row.model}</span>
                  <span className="tabular-nums">
                    {row.requests} 次 · {formatUsd(row.costUsd)}
                    {Number.isFinite(row.inputTokens) && Number.isFinite(row.outputTokens) && (
                      <> · 输入 {row.inputTokens} / 输出 {row.outputTokens} token</>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : <p>{daily.date} UTC · 官方暂无用量记录</p>
      )}
      {warning && <p>{warning}</p>}
      <p>
        免费模型按账号限流。{freeLimitReference && (
          <a href={freeLimitReference.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
            官方参考配置为 {freeLimitReference.requestsPerHour} 次/小时。
          </a>
        )}Kilo 未提供本小时的实时剩余次数。
      </p>
      <a href={detailUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">查看 Kilo 官方用量</a>
    </div>
  );
}
