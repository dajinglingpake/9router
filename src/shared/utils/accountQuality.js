export const ACCOUNT_QUALITY_LABELS = {
  normal: "未降智",
  slow: "响应慢",
  degraded: "已降智",
};

export function getAccountQualityStatus(connection) {
  if (connection?.qualityStatus === undefined) return connection?.isDegraded === true ? "degraded" : null;
  return Object.hasOwn(ACCOUNT_QUALITY_LABELS, connection.qualityStatus) ? connection.qualityStatus : null;
}

export function getAccountQualityMarkedAt(connection) {
  const status = getAccountQualityStatus(connection);
  if (!status) return null;
  const value = connection.qualityMarkedAt ?? (connection.qualityStatus === undefined ? connection.degradedMarkedAt : null);
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}
