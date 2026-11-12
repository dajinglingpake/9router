const KILO_API_BASE = "https://api.kilo.ai";

export const KILO_MODELS_CONFIG = {
  url: "https://ai-gateway.kilo.ai/api/v1/models",
  timeoutMs: 10000,
  cacheTtlMs: 10 * 60 * 1000,
};

export default {
  id: "kilocode",
  priority: 70,
  alias: "kc",
  uiAlias: "kc",
  display: {
    name: "Kilo Code",
    icon: "code",
    color: "#FF6B35",
    textIcon: "KC",
    website: "https://kilocode.ai",
    notice: {
      signupUrl: "https://kilocode.ai",
    },
  },
  category: "oauth",
  transport: {
    baseUrl: `${KILO_API_BASE}/api/openrouter/chat/completions`,
    usage: {
      balanceUrl: `${KILO_API_BASE}/api/profile/balance`,
      usageUrl: `${KILO_API_BASE}/api/profile/usage`,
      dashboardUrl: "https://app.kilo.ai",
      // Published firewall configuration, not a live account counter.
      freeLimitReference: { requestsPerHour: 300, url: "https://github.com/Kilo-Org/cloud/pull/8456" },
    },
    headers: {},
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
      hooks: [
        "kilocodeOrg",
      ],
    },
  },
  // Legacy seeds for callers that only consume the static registry.
  models: [
    { id: "anthropic/claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
    { id: "anthropic/claude-opus-4-20250514", name: "Claude Opus 4" },
    { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "openai/gpt-4.1", name: "GPT-4.1" },
    { id: "openai/o3", name: "o3" },
    { id: "deepseek/deepseek-chat", name: "DeepSeek Chat" },
    { id: "deepseek/deepseek-reasoner", name: "DeepSeek Reasoner" },
  ],
  passthroughModels: true,
  features: { usage: true },
  oauth: {
    apiBaseUrl: KILO_API_BASE,
    initiateUrl: `${KILO_API_BASE}/api/device-auth/codes`,
    pollUrlBase: `${KILO_API_BASE}/api/device-auth/codes`,
  },
};
