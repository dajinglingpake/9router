export function getExclusiveApiKeyIds(connection) {
  if (Array.isArray(connection?.exclusiveApiKeyIds)) return connection.exclusiveApiKeyIds;
  return connection?.exclusiveApiKeyId ? [connection.exclusiveApiKeyId] : [];
}
