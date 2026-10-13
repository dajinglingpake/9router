export const ACCOUNT_QUALITY_LABELS = {
  normal: "未降智",
  slow: "响应慢",
  degraded: "已降智",
};
export const ACCOUNT_QUALITY_MAX_LENGTH = 80;

export function getAccountQualityStatus(connection) {
  if (connection?.qualityStatus === undefined) return connection?.isDegraded === true ? "degraded" : null;
  if (connection.qualityStatus === "custom") {
    const label = connection.qualityLabel;
    return typeof label === "string" && label.trim() && label.trim().length <= ACCOUNT_QUALITY_MAX_LENGTH ? "custom" : null;
  }
  return Object.hasOwn(ACCOUNT_QUALITY_LABELS, connection.qualityStatus) ? connection.qualityStatus : null;
}

export function getAccountQualityLabel(connection) {
  const status = getAccountQualityStatus(connection);
  return status === "custom" ? connection.qualityLabel.trim() : ACCOUNT_QUALITY_LABELS[status] || "";
}

export function getAccountQualityMarkedAt(connection) {
  const status = getAccountQualityStatus(connection);
  if (!status) return null;
  const value = connection.qualityMarkedAt ?? (connection.qualityStatus === undefined ? connection.degradedMarkedAt : null);
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}
