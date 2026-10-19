// Diagnostic identity only: never accepted as a gateway credential.
export const CODEX_TRIAL_IDENTITY = Object.freeze({
  id: "codex-account-test", name: "Codex 账号测试", key: "9r-trial-account-test",
});

export function getCodexTrialIdentity(value, historicalName) {
  return value === CODEX_TRIAL_IDENTITY.id || (typeof value === "string" && value.startsWith("9r-trial-"))
    || (!value && (historicalName === "Codex 账号对比" || historicalName === CODEX_TRIAL_IDENTITY.name))
    ? CODEX_TRIAL_IDENTITY : null;
}
