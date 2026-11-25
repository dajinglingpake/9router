// Free-tier limits verified in this project's Google quota console on 2026-11-25.
// Only exact model IDs with a confirmed limit get a default.
const flash = { rpm: 5, tpm: 250000, rpd: 20 };
const lite = { rpm: 15, tpm: 250000, rpd: 500 };
const zero = { rpm: 0, tpm: 0, rpd: 0 };

export const geminiQuotaDefaults = {
  "gemini-2.5-flash": flash,
  "gemini-3.5-flash": flash,
  "gemini-3.6-flash": flash,
  "gemini-3.7-flash": flash,
  "gemini-3.8-flash": flash,
  "gemini-4-hydrogen": flash,
  "gemini-2.5-flash-lite": { rpm: 10, tpm: 250000, rpd: 20 },
  "gemini-3.1-flash-lite": lite,
  "gemini-3.5-flash-lite": lite,
  "gemini-2.5-pro": zero,
  "gemini-4-argon": zero,
  "gemini-4-carbon": zero,
  "gemini-4-neon": zero,
};

export function defaultGeminiLimits(model) {
  return Object.hasOwn(geminiQuotaDefaults, model) ? geminiQuotaDefaults[model] : {};
}

export function geminiQuotaOverrides(model, limits) {
  const defaults = defaultGeminiLimits(model);
  return Object.fromEntries(Object.entries(limits || {}).filter(([key, value]) =>
    ["rpm", "tpm", "rpd"].includes(key) && Number.isSafeInteger(value) && value >= 0 && value !== defaults[key]
  ));
}
