// Pricing rates for AI models — all rates in $/1M tokens
//
// Fallback order (first match wins):
//   1. PROVIDER_PRICING[provider][model]  — provider-specific override
//   2. MODEL_PRICING[model]               — canonical model price (provider-agnostic)
//   3. PATTERN_PRICING                    — glob pattern match (e.g. "codex-*")

/**
 * Canonical model pricing — provider-agnostic.
 * Cover all known models; deduplicated across providers.
 */
export const MODEL_PRICING = {
  // === Anthropic / Claude ===
  "claude-opus-4-6":              { input: 5.00,  output: 25.00, cached: 0.50,  reasoning: 25.00,  cache_creation: 6.25  },
  "claude-opus-4-5-20251101":     { input: 5.00,  output: 25.00, cached: 0.50,  reasoning: 25.00,  cache_creation: 6.25  },
  "claude-sonnet-4-6":            { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 15.00,  cache_creation: 3.75  },
  "claude-sonnet-4-5-20250929":   { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 15.00,  cache_creation: 3.75  },
  "claude-haiku-4-5-20251001":    { input: 1.00,  output: 5.00,  cached: 0.10,  reasoning: 5.00,   cache_creation: 1.25  },
  "claude-sonnet-4-20250514":     { input: 3.00,  output: 15.00, cached: 1.50,  reasoning: 15.00,  cache_creation: 3.00  },
  "claude-opus-4-20250514": { input: 15.00, output: 75.00, cached: 1.5, reasoning: 75.00, cache_creation: 18.75 },
  "claude-3-5-sonnet-20241022":   { input: 3.00,  output: 15.00, cached: 1.50,  reasoning: 15.00,  cache_creation: 3.00  },
  "claude-haiku-4.5": { input: 1.00, output: 5.00, cached: 0.1, reasoning: 5.00, cache_creation: 1.25 },
  "claude-opus-4.1": { input: 15.00, output: 75.00, cached: 1.5, reasoning: 75.00, cache_creation: 18.75 },
  "claude-opus-4.5": { input: 5.00, output: 25.00, cached: 0.5, reasoning: 25.00, cache_creation: 6.25 },
  "claude-opus-4.6": { input: 5.00, output: 25.00, cached: 0.5, reasoning: 25.00, cache_creation: 6.25 },
  "claude-sonnet-4": { input: 3.00, output: 15.00, cached: 0.3, reasoning: 15.00, cache_creation: 3.75 },
  "claude-sonnet-4.5": { input: 3.00, output: 15.00, cached: 0.3, reasoning: 15.00, cache_creation: 3.75 },
  "claude-sonnet-4.6": { input: 3.00, output: 15.00, cached: 0.3, reasoning: 15.00, cache_creation: 3.75 },
  "claude-opus-4-5-thinking": { input: 5.00, output: 25.00, cached: 0.5, reasoning: 25.00, cache_creation: 6.25 },
  "claude-opus-4-6-thinking": { input: 5.00, output: 25.00, cached: 0.5, reasoning: 25.00, cache_creation: 6.25 },

  // === OpenAI / GPT ===
  "gpt-3.5-turbo":                { input: 0.50,  output: 1.50,  cached: 0.25,  reasoning: 2.25,   cache_creation: 0.50  },
  "gpt-4":                        { input: 2.50,  output: 10.00, cached: 1.25,  reasoning: 15.00,  cache_creation: 2.50  },
  "gpt-4-turbo":                  { input: 10.00, output: 30.00, cached: 5.00,  reasoning: 45.00,  cache_creation: 10.00 },
  "gpt-4o":                       { input: 2.50,  output: 10.00, cached: 1.25,  reasoning: 15.00,  cache_creation: 2.50  },
  "gpt-4o-mini":                  { input: 0.15,  output: 0.60,  cached: 0.075, reasoning: 0.90,   cache_creation: 0.15  },
  "gpt-4.1":                      { input: 2.50,  output: 10.00, cached: 1.25,  reasoning: 15.00,  cache_creation: 2.50  },
  "gpt-5": { input: 1.25, output: 10.00, cached: 0.125, reasoning: 10.00, cache_creation: 1.25 },
  "gpt-5-mini":                   { input: 0.75,  output: 3.00,  cached: 0.375, reasoning: 4.50,   cache_creation: 0.75  },
  "gpt-5-codex": { input: 1.25, output: 10.00, cached: 0.125, reasoning: 10.00, cache_creation: 1.25 },
  "gpt-5.1":                      { input: 4.00,  output: 16.00, cached: 2.00,  reasoning: 24.00,  cache_creation: 4.00  },
  "gpt-5.1-codex":                { input: 4.00,  output: 16.00, cached: 2.00,  reasoning: 24.00,  cache_creation: 4.00  },
  "gpt-5.1-codex-mini":           { input: 1.50,  output: 6.00,  cached: 0.75,  reasoning: 9.00,   cache_creation: 1.50  },
  "gpt-5.1-codex-mini-high":      { input: 2.00,  output: 8.00,  cached: 1.00,  reasoning: 12.00,  cache_creation: 2.00  },
  "gpt-5.1-codex-max":            { input: 8.00,  output: 32.00, cached: 4.00,  reasoning: 48.00,  cache_creation: 8.00  },
  "gpt-5.2":                      { input: 5.00,  output: 20.00, cached: 2.50,  reasoning: 30.00,  cache_creation: 5.00  },
  "gpt-5.2-codex":                { input: 5.00,  output: 20.00, cached: 2.50,  reasoning: 30.00,  cache_creation: 5.00  },
  "gpt-5.3-codex": { input: 1.75, output: 14.00, cached: 0.175, reasoning: 14.00, cache_creation: 1.75 },
  "gpt-5.3-codex-xhigh":         { input: 10.00, output: 40.00, cached: 5.00,  reasoning: 60.00,  cache_creation: 10.00 },
  "gpt-5.3-codex-high":          { input: 8.00,  output: 32.00, cached: 4.00,  reasoning: 48.00,  cache_creation: 8.00  },
  "gpt-5.3-codex-low":           { input: 4.00,  output: 16.00, cached: 2.00,  reasoning: 24.00,  cache_creation: 4.00  },
  "gpt-5.3-codex-none":          { input: 3.00,  output: 12.00, cached: 1.50,  reasoning: 18.00,  cache_creation: 3.00  },
  "gpt-5.3-codex-spark":         { input: 1.75,  output: 14.00, cached: 0.175, reasoning: 14.00,  cache_creation: 1.75  },
  "gpt-5.4": { input: 2.5, output: 15.00, cached: 0.25, reasoning: 15.00, cache_creation: 2.5 },
  "gpt-5.5": { input: 5.00, output: 30.00, cached: 0.5, reasoning: 30.00, cache_creation: 5.00 },
  "o1":                           { input: 15.00, output: 60.00, cached: 7.50,  reasoning: 90.00,  cache_creation: 15.00 },
  "o1-mini":                      { input: 3.00,  output: 12.00, cached: 1.50,  reasoning: 18.00,  cache_creation: 3.00  },

  // === Gemini ===
  "gemini-3-flash-preview": { input: 0.5, output: 3.00, cached: 0.05, reasoning: 3.00, cache_creation: 0.5 },
  "gemini-3-pro-preview":         { input: 2.00,  output: 12.00, cached: 0.25,  reasoning: 18.00,  cache_creation: 2.00  },
  "gemini-3.1-pro-low":           { input: 2.00,  output: 12.00, cached: 0.25,  reasoning: 18.00,  cache_creation: 2.00  },
  "gemini-3.1-pro-high":          { input: 4.00,  output: 18.00, cached: 0.50,  reasoning: 27.00,  cache_creation: 4.00  },
  "gemini-pro-agent":             { input: 4.00,  output: 18.00, cached: 0.50,  reasoning: 27.00,  cache_creation: 4.00  },
  "gemini-3-flash-agent": { input: 0.5, output: 3.00, cached: 0.05, reasoning: 3.00, cache_creation: 0.5 },
  "gemini-3.5-flash-low":         { input: 0.50,  output: 3.00,  cached: 0.03,  reasoning: 4.50,   cache_creation: 0.50  },
  "gemini-3-flash": { input: 0.5, output: 3.00, cached: 0.05, reasoning: 3.00, cache_creation: 0.5 },
  "gemini-2.5-pro": { input: 1.25, output: 10.00, cached: 0.125, reasoning: 10.00, cache_creation: 1.25 },
  "gemini-2.5-flash":             { input: 0.30,  output: 2.50,  cached: 0.03,  reasoning: 3.75,   cache_creation: 0.30  },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4, cached: 0.01, reasoning: 0.4, cache_creation: 0.1 },

  // === Qwen ===
  "qwen3-coder-plus": { input: 0.574, output: 2.29, cached: 0.115, reasoning: 2.29, cache_creation: 0.574 },
  "qwen3-coder-flash": { input: 0.144, output: 0.574, cached: 0.029, reasoning: 0.574, cache_creation: 0.144 },

  // === Kimi ===
  "kimi-k2":                      { input: 1.00,  output: 4.00,  cached: 0.50,  reasoning: 6.00,   cache_creation: 1.00  },
  "kimi-k2-thinking":             { input: 1.50,  output: 6.00,  cached: 0.75,  reasoning: 9.00,   cache_creation: 1.50  },
  "kimi-k2.5": { input: 0.6, output: 3.00, cached: 0.1, reasoning: 3.00, cache_creation: 0.6 },
  "kimi-k2.5-thinking": { input: 0.6, output: 3.00, cached: 0.1, reasoning: 3.00, cache_creation: 0.6 },
  "kimi-k2.6": { input: 0.95, output: 4.00, cached: 0.16, reasoning: 4.00, cache_creation: 0.95 },
  "kimi-latest":                  { input: 1.00,  output: 4.00,  cached: 0.50,  reasoning: 6.00,   cache_creation: 1.00  },

  // === DeepSeek ===
  "deepseek-chat":                { input: 0.14,  output: 0.28,  cached: 0.0028, reasoning: 0.28,   cache_creation: 0.14  },
  "deepseek-reasoner":            { input: 0.14,  output: 0.28,  cached: 0.0028, reasoning: 0.28,   cache_creation: 0.14  },
  "deepseek-r1":                  { input: 0.14,  output: 0.28,  cached: 0.0028, reasoning: 0.28,   cache_creation: 0.14  },
  "deepseek-v3.2-chat":           { input: 0.14,  output: 0.28,  cached: 0.0028, reasoning: 0.28,   cache_creation: 0.14  },
  "deepseek-v3.2-reasoner":       { input: 0.14,  output: 0.28,  cached: 0.0028, reasoning: 0.28,   cache_creation: 0.14  },
  "deepseek-v4-flash": { input: 0.14, output: 0.28, cached: 0.003, reasoning: 0.28, cache_creation: 0.14 },
  "deepseek-v4-pro": { input: 0.435, output: 0.87, cached: 0.004, reasoning: 0.87, cache_creation: 0.435 },

  // === GLM ===
  "glm-4.6":                      { input: 0.50,  output: 2.00,  cached: 0.25,  reasoning: 3.00,   cache_creation: 0.50  },
  "glm-4.6v":                     { input: 0.75,  output: 3.00,  cached: 0.375, reasoning: 4.50,   cache_creation: 0.75  },
  "glm-4.7": { input: 0.294, output: 1.18, cached: 0.059, reasoning: 1.18, cache_creation: 0.294 },
  "glm-5": { input: 0.589, output: 2.65, cached: 0.147, reasoning: 2.65, cache_creation: 0.589 },

  // === MiniMax ===
  "MiniMax-M2.1": { input: 0.309, output: 1.24, cached: 0.031, reasoning: 1.24, cache_creation: 0.386 },
  "MiniMax-M2.5": { input: 0.309, output: 1.24, cached: 0.031, reasoning: 1.24, cache_creation: 0.386 },
  "MiniMax-M2.7": { input: 0.309, output: 1.24, cached: 0.062, reasoning: 1.24, cache_creation: 0.386 },
  "minimax-m2.1": { input: 0.309, output: 1.24, cached: 0.031, reasoning: 1.24, cache_creation: 0.386 },
  "minimax-m2.5": { input: 0.309, output: 1.24, cached: 0.031, reasoning: 1.24, cache_creation: 0.386 },

  // === Grok ===
  "grok-code-fast-1": { input: 1.00, output: 2.00, cached: 0.2, reasoning: 2.00, cache_creation: 1.00 },

  // === OpenRouter fallback ===
  "auto":                         { input: 2.00,  output: 8.00,  cached: 1.00,  reasoning: 12.00,  cache_creation: 2.00  },

  // === Misc ===
  "oswe-vscode-prime":            { input: 1.00,  output: 4.00,  cached: 0.50,  reasoning: 6.00,   cache_creation: 1.00  },
  "gpt-oss-120b-medium":          { input: 0.50,  output: 2.00,  cached: 0.25,  reasoning: 3.00,   cache_creation: 0.50  },
  "vision-model":                 { input: 1.50,  output: 6.00,  cached: 0.75,  reasoning: 9.00,   cache_creation: 1.50  },
  "coder-model":                  { input: 1.50,  output: 6.00,  cached: 0.75,  reasoning: 9.00,   cache_creation: 1.50  },
};

/**
 * Provider-specific pricing overrides.
 * Only include entries where price DIFFERS from MODEL_PRICING.
 * Keyed by provider alias (cc, cx, gc, gh, ...) or provider id (openai, anthropic, ...).
 */
export const PROVIDER_PRICING = {
};

/**
 * Pattern-based pricing fallback — matched when no exact model entry found.
 * Patterns use simple glob: "*" matches any substring.
 * First match wins — order matters.
 */
export const PATTERN_PRICING = [
  // --- Codex variants ---
  { pattern: "*-codex-xhigh",   pricing: { input: 10.00, output: 40.00, cached: 5.00,  reasoning: 60.00,  cache_creation: 10.00 } },
  { pattern: "*-codex-high",    pricing: { input: 8.00,  output: 32.00, cached: 4.00,  reasoning: 48.00,  cache_creation: 8.00  } },
  { pattern: "*-codex-max",     pricing: { input: 8.00,  output: 32.00, cached: 4.00,  reasoning: 48.00,  cache_creation: 8.00  } },
  { pattern: "*-codex-mini-*",  pricing: { input: 1.50,  output: 6.00,  cached: 0.75,  reasoning: 9.00,   cache_creation: 1.50  } },
  { pattern: "*-codex-mini",    pricing: { input: 1.50,  output: 6.00,  cached: 0.75,  reasoning: 9.00,   cache_creation: 1.50  } },
  { pattern: "*-codex-low",     pricing: { input: 4.00,  output: 16.00, cached: 2.00,  reasoning: 24.00,  cache_creation: 4.00  } },
  { pattern: "*-codex-none",    pricing: { input: 3.00,  output: 12.00, cached: 1.50,  reasoning: 18.00,  cache_creation: 3.00  } },
  { pattern: "*-codex-spark", pricing: { input: 1.75, output: 14.00, cached: 0.175, reasoning: 14.00, cache_creation: 1.75 } },
  { pattern: "codex-*", pricing: { input: 1.25, output: 10.00, cached: 0.125, reasoning: 10.00, cache_creation: 1.25 } },
  { pattern: "*-codex", pricing: { input: 1.25, output: 10.00, cached: 0.125, reasoning: 10.00, cache_creation: 1.25 } },

  // --- Claude ---
  { pattern: "claude-opus-4-1*", pricing: { input: 15.00, output: 75.00, cached: 1.50,  reasoning: 75.00,  cache_creation: 18.75 } },
  { pattern: "claude-opus-4.1*", pricing: { input: 15.00, output: 75.00, cached: 1.50,  reasoning: 75.00,  cache_creation: 18.75 } },
  { pattern: "claude-opus-4-2025*", pricing: { input: 15.00, output: 75.00, cached: 1.50,  reasoning: 75.00,  cache_creation: 18.75 } },
  { pattern: "claude-opus-*",   pricing: { input: 5.00,  output: 25.00, cached: 0.50,  reasoning: 25.00,  cache_creation: 6.25  } },
  { pattern: "claude-sonnet-*", pricing: { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 15.00,  cache_creation: 3.75  } },
  { pattern: "claude-haiku-*",  pricing: { input: 1.00,  output: 5.00,  cached: 0.10,  reasoning: 5.00,   cache_creation: 1.25  } },
  { pattern: "claude-*",        pricing: { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 15.00,  cache_creation: 3.75  } },

  // --- Gemini (specific first, generic last) ---
  { pattern: "gemini-*-flash-lite", pricing: { input: 0.1, output: 0.4, cached: 0.01, reasoning: 0.4, cache_creation: 0.1 } },
  { pattern: "gemini-*-flash",  pricing: { input: 0.30,  output: 2.50,  cached: 0.03,  reasoning: 3.75,   cache_creation: 0.30  } },
  { pattern: "gemini-*-pro", pricing: { input: 1.25, output: 10.00, cached: 0.125, reasoning: 10.00, cache_creation: 1.25 } },
  { pattern: "gemini-3-flash*", pricing: { input: 0.5, output: 3.00, cached: 0.05, reasoning: 3.00, cache_creation: 0.5 } },
  { pattern: "gemini-3-*", pricing: { input: 0.5, output: 3.00, cached: 0.05, reasoning: 3.00, cache_creation: 0.5 } },
  { pattern: "gemini-2.5-*",    pricing: { input: 0.30,  output: 2.50,  cached: 0.03,  reasoning: 3.75,   cache_creation: 0.30  } },
  { pattern: "gemini-*", pricing: { input: 0.5, output: 3.00, cached: 0.05, reasoning: 3.00, cache_creation: 0.5 } },

  // --- GPT (specific first, generic last) ---
  { pattern: "gpt-5.5*", pricing: { input: 5.00, output: 30.00, cached: 0.5, reasoning: 30.00, cache_creation: 5.00 } },
  { pattern: "gpt-5.4*", pricing: { input: 2.5, output: 15.00, cached: 0.25, reasoning: 15.00, cache_creation: 2.5 } },
  { pattern: "gpt-5.3-codex*", pricing: { input: 1.75, output: 14.00, cached: 0.175, reasoning: 14.00, cache_creation: 1.75 } },
  { pattern: "gpt-5.3-*", pricing: { input: 1.75, output: 14.00, cached: 0.175, reasoning: 14.00, cache_creation: 1.75 } },
  { pattern: "gpt-5.2-*",       pricing: { input: 5.00,  output: 20.00, cached: 2.50,  reasoning: 30.00,  cache_creation: 5.00  } },
  { pattern: "gpt-5.1-*",       pricing: { input: 4.00,  output: 16.00, cached: 2.00,  reasoning: 24.00,  cache_creation: 4.00  } },
  { pattern: "gpt-5-*", pricing: { input: 1.25, output: 10.00, cached: 0.125, reasoning: 10.00, cache_creation: 1.25 } },
  { pattern: "gpt-5*", pricing: { input: 1.25, output: 10.00, cached: 0.125, reasoning: 10.00, cache_creation: 1.25 } },
  { pattern: "gpt-4o-*",        pricing: { input: 0.15,  output: 0.60,  cached: 0.075, reasoning: 0.90,   cache_creation: 0.15  } },
  { pattern: "gpt-4o",          pricing: { input: 2.50,  output: 10.00, cached: 1.25,  reasoning: 15.00,  cache_creation: 2.50  } },
  { pattern: "gpt-4*",          pricing: { input: 2.50,  output: 10.00, cached: 1.25,  reasoning: 15.00,  cache_creation: 2.50  } },

  // --- o1 / o-series ---
  { pattern: "o1-*",            pricing: { input: 3.00,  output: 12.00, cached: 1.50,  reasoning: 18.00,  cache_creation: 3.00  } },
  { pattern: "o1",              pricing: { input: 15.00, output: 60.00, cached: 7.50,  reasoning: 90.00,  cache_creation: 15.00 } },
  { pattern: "o3-*",            pricing: { input: 10.00, output: 40.00, cached: 5.00,  reasoning: 60.00,  cache_creation: 10.00 } },
  { pattern: "o4-*",            pricing: { input: 2.00,  output: 8.00,  cached: 1.00,  reasoning: 12.00,  cache_creation: 2.00  } },

  // --- Qwen ---
  { pattern: "qwen3-coder-plus*", pricing: { input: 0.574, output: 2.29, cached: 0.115, reasoning: 2.29, cache_creation: 0.574 } },
  { pattern: "qwen3-coder-flash*", pricing: { input: 0.144, output: 0.574, cached: 0.029, reasoning: 0.574, cache_creation: 0.144 } },
  { pattern: "qwen3-coder-*", pricing: { input: 0.574, output: 2.29, cached: 0.115, reasoning: 2.29, cache_creation: 0.574 } },
  { pattern: "qwen*-coder-*", pricing: { input: 0.574, output: 2.29, cached: 0.115, reasoning: 2.29, cache_creation: 0.574 } },
  { pattern: "qwen*",           pricing: { input: 0.50,  output: 2.00,  cached: 0.25,  reasoning: 3.00,   cache_creation: 0.50  } },

  // --- Kimi ---
  { pattern: "kimi-k2.6*", pricing: { input: 0.95, output: 4.00, cached: 0.16, reasoning: 4.00, cache_creation: 0.95 } },
  { pattern: "kimi-k2.5*", pricing: { input: 0.6, output: 3.00, cached: 0.1, reasoning: 3.00, cache_creation: 0.6 } },
  { pattern: "kimi-*-thinking", pricing: { input: 0.6, output: 3.00, cached: 0.1, reasoning: 3.00, cache_creation: 0.6 } },
  { pattern: "kimi-k2*", pricing: { input: 0.6, output: 3.00, cached: 0.1, reasoning: 3.00, cache_creation: 0.6 } },
  { pattern: "kimi-*",          pricing: { input: 1.00,  output: 4.00,  cached: 0.50,  reasoning: 6.00,   cache_creation: 1.00  } },

  // --- DeepSeek ---
  { pattern: "deepseek-*reasoner*", pricing: { input: 0.14, output: 0.28, cached: 0.0028, reasoning: 0.28, cache_creation: 0.14 } },
  { pattern: "deepseek-r*",     pricing: { input: 0.14,  output: 0.28,  cached: 0.0028, reasoning: 0.28,   cache_creation: 0.14  } },
  { pattern: "deepseek-v*",     pricing: { input: 0.14,  output: 0.28,  cached: 0.0028, reasoning: 0.28,   cache_creation: 0.14  } },
  { pattern: "deepseek-*",      pricing: { input: 0.14,  output: 0.28,  cached: 0.0028, reasoning: 0.28,   cache_creation: 0.14  } },

  // --- GLM ---
  { pattern: "glm-5*", pricing: { input: 0.589, output: 2.65, cached: 0.147, reasoning: 2.65, cache_creation: 0.589 } },
  { pattern: "glm-4.7*", pricing: { input: 0.294, output: 1.18, cached: 0.059, reasoning: 1.18, cache_creation: 0.294 } },
  { pattern: "glm-4*", pricing: { input: 0.294, output: 1.18, cached: 0.059, reasoning: 1.18, cache_creation: 0.294 } },
  { pattern: "glm-*",           pricing: { input: 0.50,  output: 2.00,  cached: 0.25,  reasoning: 3.00,   cache_creation: 0.50  } },

  // --- MiniMax ---
  { pattern: "MiniMax-M2.7*", pricing: { input: 0.309, output: 1.24, cached: 0.062, reasoning: 1.24, cache_creation: 0.386 } },
  { pattern: "minimax-m2.7*", pricing: { input: 0.309, output: 1.24, cached: 0.062, reasoning: 1.24, cache_creation: 0.386 } },
  { pattern: "MiniMax-*", pricing: { input: 0.309, output: 1.24, cached: 0.031, reasoning: 1.24, cache_creation: 0.386 } },
  { pattern: "minimax-*", pricing: { input: 0.309, output: 1.24, cached: 0.031, reasoning: 1.24, cache_creation: 0.386 } },

  // --- Grok ---
  { pattern: "grok-code-*", pricing: { input: 1.00, output: 2.00, cached: 0.2, reasoning: 2.00, cache_creation: 1.00 } },
  { pattern: "grok-*", pricing: { input: 1.00, output: 2.00, cached: 0.2, reasoning: 2.00, cache_creation: 1.00 } },
];

/**
 * Match a model ID against a glob pattern (* = wildcard).
 */
function matchPattern(pattern, model) {
  const regex = new RegExp("^" + pattern.split("*").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return regex.test(model);
}

/**
 * Resolve pricing for a model using the 3-step fallback chain:
 *   1. PROVIDER_PRICING[provider][model]
 *   2. MODEL_PRICING[model]
 *   3. PATTERN_PRICING (glob match)
 *
 * @param {string} provider
 * @param {string} model
 * @returns {object|null}
 */
export function getPricingForModel(provider, model) {
  if (!model) return null;

  // 1. Provider-specific override
  if (provider && PROVIDER_PRICING[provider]?.[model]) {
    return PROVIDER_PRICING[provider][model];
  }

  // 2. Canonical model pricing (strip vendor prefix if needed: "deepseek/deepseek-chat" → "deepseek-chat")
  const baseModel = model.includes("/") ? model.split("/").pop() : model;
  if (MODEL_PRICING[baseModel]) return MODEL_PRICING[baseModel];
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];

  // 3. Pattern match
  for (const { pattern, pricing } of PATTERN_PRICING) {
    if (matchPattern(pattern, baseModel) || matchPattern(pattern, model)) {
      return pricing;
    }
  }

  return null;
}

/**
 * Get all provider pricing (for UI / API).
 * Returns PROVIDER_PRICING — consumers should fall back to MODEL_PRICING for unlisted models.
 */
export function getDefaultPricing() {
  return PROVIDER_PRICING;
}

/**
 * Format cost for display
 * @param {number} cost
 * @returns {string}
 */
export function formatCost(cost) {
  if (cost === null || cost === undefined || isNaN(cost)) return "$0.00";
  return `$${cost.toFixed(2)}`;
}

/**
 * Calculate cost from tokens and pricing
 * @param {object} tokens
 * @param {object} pricing
 * @returns {number} cost in dollars
 */
export function calculateCostFromTokens(tokens, pricing) {
  if (!tokens || !pricing) return 0;

  let cost = 0;

  const inputTokens = tokens.prompt_tokens || tokens.input_tokens || 0;
  const cachedTokens = tokens.cached_tokens || tokens.cache_read_input_tokens || 0;
  const nonCachedInput = Math.max(0, inputTokens - cachedTokens);

  cost += nonCachedInput * (pricing.input / 1000000);

  if (cachedTokens > 0) {
    cost += cachedTokens * ((pricing.cached || pricing.input) / 1000000);
  }

  const outputTokens = tokens.completion_tokens || tokens.output_tokens || 0;
  cost += outputTokens * (pricing.output / 1000000);

  const reasoningTokens = tokens.reasoning_tokens || 0;
  if (reasoningTokens > 0) {
    cost += reasoningTokens * ((pricing.reasoning || pricing.output) / 1000000);
  }

  const cacheCreationTokens = tokens.cache_creation_input_tokens || 0;
  if (cacheCreationTokens > 0) {
    cost += cacheCreationTokens * ((pricing.cache_creation || pricing.input) / 1000000);
  }

  return cost;
}
