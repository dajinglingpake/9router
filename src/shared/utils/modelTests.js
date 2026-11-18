export const MODEL_TEST_PROVIDERS = ["opencode", "nvidia", "kilocode"];

export function modelTestRank(status) {
  if (status === "ok") return 0;
  if (status === "error") return 2;
  return 1;
}
