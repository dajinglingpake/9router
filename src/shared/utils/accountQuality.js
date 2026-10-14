export const ACCOUNT_QUALITY_LABELS = {
  normal: "未降智",
  slow: "响应慢",
  degraded: "已降智",
};
export const ACCOUNT_QUALITY_MAX_LENGTH = 80;
export const ACCOUNT_QUALITY_DEFAULT_COLOR = "#a64027";
export const ACCOUNT_QUALITY_COLORS = [
  { label: "橙色", value: ACCOUNT_QUALITY_DEFAULT_COLOR },
  { label: "绿色", value: "#15803d" },
  { label: "红色", value: "#b91c1c" },
  { label: "黄色", value: "#facc15" },
  { label: "蓝色", value: "#1d4ed8" },
  { label: "紫色", value: "#7e22ce" },
];

export function isAccountQualityColor(color) {
  return typeof color === "string" && color.length === 7 && /^#[0-9a-f]{6}$/i.test(color);
}

export function getAccountQualityColor(connection) {
  return isAccountQualityColor(connection?.qualityColor) ? connection.qualityColor.toLowerCase() : ACCOUNT_QUALITY_DEFAULT_COLOR;
}

export function getAccountQualityTextColor(color) {
  const channels = getAccountQualityColor({ qualityColor: color }).slice(1).match(/../g).map(hex => {
    const value = parseInt(hex, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#000000" : "#ffffff";
}

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

export function getAccountQualityMetadata(connection) {
  const qualityStatus = getAccountQualityStatus(connection);
  return qualityStatus ? {
    qualityStatus,
    qualityLabel: getAccountQualityLabel(connection),
    qualityColor: getAccountQualityColor(connection),
    qualityMarkedAt: getAccountQualityMarkedAt(connection),
  } : {};
}
