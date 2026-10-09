// Compare valid quota snapshots within the idle/busy candidate group.
// Unknown quota must not be treated as a full account.
export function preferHighestQuota(connections, quotaStates) {
  const known = connections.filter(connection => Number.isFinite(quotaStates.get(connection.id)?.usedPercent));
  if (!known.length) return connections;
  const lowestUsed = Math.min(...known.map(connection => quotaStates.get(connection.id).usedPercent));
  return known.filter(connection => quotaStates.get(connection.id).usedPercent === lowestUsed);
}
