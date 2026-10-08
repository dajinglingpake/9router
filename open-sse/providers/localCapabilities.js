import { CODEX_SPARK_CONTEXT_WINDOW, CODEX_SPARK_MODEL_GLOB } from "../config/codexConstants.js";

// Upstream provider entries take precedence when they gain the same model.
export const LOCAL_CODEX_CAPABILITIES = {
  "gpt-6.1-sol": {
    vision: true, reasoning: true, search: true, thinkingFormat: "openai",
    thinkingCanDisable: false, contextWindow: 272000, maxOutput: 128000,
  },
};

export const LOCAL_PATTERN_CAPABILITIES = [{
  pattern: CODEX_SPARK_MODEL_GLOB,
  caps: {
    reasoning: true, search: true, thinkingFormat: "openai",
    contextWindow: CODEX_SPARK_CONTEXT_WINDOW, maxOutput: 128000,
  },
}];
