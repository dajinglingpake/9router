// Called under accountSelection's mutex; reservations include selections that
// have not entered the concurrency limiter yet.
export function selectBalancedAccount(connections, strategy, loads, reservations, cursors, scope) {
  if (!connections.length) return null;
  const load = connection => {
    const pool = loads.find(item => item.scope === "account" && item.id === connection.id);
    const active = (pool?.active || 0) + (reservations.get(connection.id) || 0);
    const limit = Number(connection.maxConcurrency) || 0;
    return { active, queued: pool?.queued || 0, limit };
  };
  const ready = connections.filter(connection => {
    const item = load(connection);
    return !item.queued && (!item.limit || item.active < item.limit);
  });
  let candidates = ready.length ? ready : connections;
  if (strategy === "fill-first") return candidates[0];
  if (strategy === "least-loaded") {
    const score = connection => {
      const item = load(connection);
      return [item.queued, item.active / (item.limit || 1)];
    };
    const sorted = [...candidates].sort((a, b) => {
      const left = score(a), right = score(b);
      return left[0] - right[0] || left[1] - right[1];
    });
    const best = score(sorted[0]);
    candidates = sorted.filter(connection => {
      const item = score(connection);
      return item[0] === best[0] && item[1] === best[1];
    });
  }
  // Remember the last account rather than an array index: the candidate set
  // changes as slots fill, quotas reset, or accounts are enabled/disabled.
  const last = cursors.get(scope);
  const lastIndex = connections.findIndex(connection => connection.id === last);
  const ordered = [...connections.slice(lastIndex + 1), ...connections.slice(0, lastIndex + 1)];
  const selected = ordered.find(connection => candidates.includes(connection)) || candidates[0];
  cursors.set(scope, selected.id);
  return selected;
}
