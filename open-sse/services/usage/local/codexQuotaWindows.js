import { CODEX_QUOTA_WINDOW_SECONDS } from "../../../config/local/codexQuotaWindows.js";

// A primary window can be weekly; its position does not identify its duration.
export function normalizeCodexQuotaWindows(quotas) {
  for (const prefix of ["", "review_", "spark_"]) {
    const windows = Object.keys(CODEX_QUOTA_WINDOW_SECONDS)
      .filter(name => quotas[`${prefix}${name}`])
      .map(name => ({ name, quota: quotas[`${prefix}${name}`] }));
    for (const { name } of windows) delete quotas[`${prefix}${name}`];
    for (const { name, quota } of windows) {
      const period = Object.keys(CODEX_QUOTA_WINDOW_SECONDS)
        .find(key => CODEX_QUOTA_WINDOW_SECONDS[key] === quota.windowSeconds) || name;
      quotas[`${prefix}${period}`] = quota;
    }
    if (!quotas[`${prefix}session`] && quotas[`${prefix}weekly`]?.windowSeconds === CODEX_QUOTA_WINDOW_SECONDS.weekly) {
      quotas[`${prefix}session`] = { ...quotas[`${prefix}weekly`], sharedWith: `${prefix}weekly` };
    }
  }
}
