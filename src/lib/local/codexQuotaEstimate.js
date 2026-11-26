import { CODEX_QUOTA_WINDOW_SECONDS } from "open-sse/config/local/codexQuotaWindows.js";
import { getModelMeta } from "open-sse/config/providerModels.js";
import { CODEX_REVIEW_SUFFIX } from "open-sse/providers/models/helpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const CODEX_ESTIMATE_LOOKBACK_DAYS = 14;
export const CODEX_ESTIMATE_LOOKBACK_MS = CODEX_ESTIMATE_LOOKBACK_DAYS * DAY_MS;
export const CODEX_ESTIMATE_MIN_DROP = 5;

function usesNormalQuota(model) {
  const id = String(model || "");
  const metadata = getModelMeta("cx", id);
  return (!metadata?.kind || metadata.kind === "llm")
    && (!metadata?.quotaFamily || metadata.quotaFamily === "normal")
    && !id.endsWith(CODEX_REVIEW_SUFFIX) && !id.includes("codex-spark");
}

function sampleBatches(rows) {
  const accounts = new Map();
  for (const row of rows) {
    if (!usesNormalQuota(row.model)) continue;
    if (!accounts.has(row.connectionId)) accounts.set(row.connectionId, []);
    const batches = accounts.get(row.connectionId);
    const sample = row.codexQuota;
    const exhausted = Object.values(sample?.windows || {}).some(window => !window.sharedWith && window.remainingPercent === 0);
    // Usage at the cap can include purchased credits or a truncated drop.
    const cost = !exhausted && Number.isFinite(row.cost) && row.cost > 0 ? row.cost : null;
    const last = batches.at(-1);
    if (sample?.sampledAt && last?.sample?.sampledAt === sample.sampledAt) {
      last.cost = last.cost !== null && cost !== null ? last.cost + cost : null;
    } else {
      batches.push({ sample, cost });
    }
  }
  return accounts;
}

function estimateWindow(batches, name, plan) {
  let baseline = null;
  let previous = null;
  let intervalCost = 0;
  let totalCost = 0;
  let totalDrop = 0;

  for (const { sample, cost } of batches) {
    const window = sample?.windows?.[name];
    const sampledAt = Date.parse(sample?.sampledAt);
    const resetAt = Date.parse(window?.resetAt);
    const percent = window?.remainingPercent;
    const valid = sample?.plan === plan && !window?.sharedWith
      && window?.windowSeconds === CODEX_QUOTA_WINDOW_SECONDS[name]
      && Number.isFinite(percent) && percent > 0 && percent <= 100
      && resetAt > sampledAt;
    if (!valid) {
      baseline = previous = null;
      continue;
    }

    // The first sample is already post-request. Only subsequent batches count.
    if (baseline === null || previous.resetAt !== resetAt || sampledAt <= previous.sampledAt || percent > previous.percent || cost === null) {
      baseline = percent;
      intervalCost = 0;
    } else {
      intervalCost += cost;
      const drop = baseline - percent;
      if (drop >= CODEX_ESTIMATE_MIN_DROP) {
        totalDrop += drop;
        totalCost += intervalCost;
        baseline = percent;
        intervalCost = 0;
      }
    }
    previous = { percent, resetAt, sampledAt };
  }

  return totalDrop > 0 ? totalCost / (totalDrop / 100) : null;
}

export function estimateCodexQuota(rows, plans) {
  const estimates = new Map();
  for (const [id, batches] of sampleBatches(rows)) {
    const plan = plans.get(id);
    if (!plan || plan === "unknown") continue;
    estimates.set(id, Object.fromEntries(
      Object.keys(CODEX_QUOTA_WINDOW_SECONDS).map(name => [name, estimateWindow(batches, name, plan)]),
    ));
  }
  return estimates;
}
