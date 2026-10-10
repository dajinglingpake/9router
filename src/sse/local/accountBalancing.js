import { getAccountActiveCount } from "./accountLoad.js";
import { preferHighestQuota } from "./quotaPriority.js";

// Called under accountSelection's mutex; reservations include selections that
// have not entered the concurrency limiter yet.
export function preferLeastLoadedAccounts(connections, loads, reservations) {
  if (!connections.length) return [];
  const scored = connections.map(connection => {
    const pool = loads.find(item => item.scope === "account" && item.id === connection.id);
    const active = Math.max(pool?.active || 0, getAccountActiveCount(connection.id)) + (reservations.get(connection.id) || 0);
    const limit = Number(connection.maxConcurrency) || 0;
    return { connection, active, queued: pool?.queued || 0, limit };
  });
  const ready = scored.filter(item => {
    return !item.queued && (!item.limit || item.active < item.limit);
  });
  const candidates = ready.length ? ready : scored;
  const minQueued = Math.min(...candidates.map(item => item.queued));
  const sameQueue = candidates.filter(item => item.queued === minQueued);
  const minActive = Math.min(...sameQueue.map(item => item.active));
  return sameQueue.filter(item => item.active === minActive).map(item => item.connection);
}

export function selectBalancedAccount(connections, strategy, loads, reservations, cursors, scope, quotaStates = new Map()) {
  let candidates = preferLeastLoadedAccounts(connections, loads, reservations);
  if (!candidates.length) return null;
  if (strategy === "fill-first") return candidates[0];
  if (strategy === "quota-priority") candidates = preferHighestQuota(candidates, quotaStates);
  // Remember the last account rather than an array index: the candidate set
  // changes as slots fill, quotas reset, or accounts are enabled/disabled.
  const last = cursors.get(scope);
  const lastIndex = connections.findIndex(connection => connection.id === last);
  const ordered = [...connections.slice(lastIndex + 1), ...connections.slice(0, lastIndex + 1)];
  const selected = ordered.find(connection => candidates.includes(connection)) || candidates[0];
  cursors.set(scope, selected.id);
  return selected;
}
