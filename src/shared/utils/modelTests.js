export const MODEL_TEST_PROVIDERS = ["opencode", "nvidia", "kilocode", "gemini"];
export const FREE_MODEL_FILTER_PROVIDERS = ["kilocode", "gemini"];
export const GEMINI_PROBE_TIMEOUT_MS = 30000;

export function filterFreeModels(models, freeOnly) {
  return freeOnly ? models.filter(model => model.isFree === true) : models;
}

export function modelTestRank(status) {
  if (status === "ok") return 0;
  if (status === "error") return 2;
  return 1;
}
