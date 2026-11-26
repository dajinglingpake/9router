import { CODEX_QUOTA_WINDOW_SECONDS } from "open-sse/config/local/codexQuotaWindows.js";
import { getProviderConnectionById } from "../db/repos/connectionsRepo.js";
import { loadConnectionUsage } from "../providerUsage.js";
import { QUOTA_FETCH_TIMEOUT_MS } from "../../sse/local/routingPolicy.js";
import { normalizeCodexPlan, remainingFraction } from "./codexQuotaSummary.js";

const samples = globalThis.__ninerouterCodexQuotaSamples ||= new Map();

async function fetchSample(connectionId) {
  const connection = await getProviderConnectionById(connectionId);
  if (connection?.provider !== "codex" || connection.authType !== "oauth" || !connection.accessToken) return null;

  const usage = await loadConnectionUsage(connection, {
    signal: AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS),
    refreshCredentials: false,
  });
  const now = Date.now();
  const windows = {};
  for (const name of Object.keys(CODEX_QUOTA_WINDOW_SECONDS)) {
    const quota = usage?.quotas?.[name];
    const remaining = remainingFraction(quota, now);
    if (remaining === null) continue;
    windows[name] = {
      remainingPercent: Number((remaining * 100).toFixed(8)),
      resetAt: quota.resetAt || null,
      windowSeconds: quota.windowSeconds || null,
      ...(quota.sharedWith && { sharedWith: quota.sharedWith }),
    };
  }
  return Object.keys(windows).length ? {
    sampledAt: new Date(now).toISOString(), plan: normalizeCodexPlan(usage.plan), windows,
  } : null;
}

export function sampleCodexQuota(connectionId) {
  const state = samples.get(connectionId) || {};
  if (state.next) return state.next;
  samples.set(connectionId, state);

  // A read only serves requests completed before it began. Coalesce completions
  // waiting for the next read while the current read is in flight.
  state.next = Promise.resolve(state.current).then(async () => {
    state.current = state.next;
    state.next = null;
    try {
      return await fetchSample(connectionId);
    } catch {
      return null;
    } finally {
      if (!state.next) samples.delete(connectionId);
    }
  });
  return state.next;
}
