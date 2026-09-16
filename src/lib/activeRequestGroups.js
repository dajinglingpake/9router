// Match by account identity and routed model, never by account alone.
export function groupActiveRequests(active = [], limits = [], stats = [], outputGroups = []) {
  const groups = active.map(request => ({
    ...request,
    queue: [],
    limit: limits.find(limit => limit.scope === "account" && (request.connectionId
      ? limit.id === request.connectionId
      : limit.label === `账号: ${request.account}`)),
  }));
  for (const limit of limits.filter(item => item.scope === "account")) {
    for (const queued of limit.queue || []) {
      const model = queued.routingModel || queued.upstreamModel || queued.requestedModel || "未知模型";
      const provider = queued.provider || groups.find(group => group.limit === limit)?.provider || "—";
      let group = groups.find(item => item.limit === limit && item.model === model && item.provider === provider);
      if (!group) {
        group = {
          model, provider, connectionId: limit.id,
          account: (limit.label || limit.id).replace(/^账号: /, ""),
          count: 0, requests: [], queue: [], latencyMs: null, limit,
        };
        groups.push(group);
      }
      group.queue.push(queued);
    }
  }
  return groups.map(group => ({
    ...group,
    stats: stats.find(item => item.connectionId === group.connectionId && item.provider === group.provider && item.model === group.model),
    outputTokensPerSecond: outputGroups.find(item => item.connectionId === group.connectionId && item.provider === group.provider && item.model === group.model)?.outputTokensPerSecond ?? 0,
  }));
}
