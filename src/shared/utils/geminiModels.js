import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

// Google's generateContent method also serves image, speech, music and agent models.
const SPECIALIZED_MODELS = /(?:^|-)(?:image|imagen|nano-banana|tts|transcribe|audio|live|lyria|veo|omni|robotics|computer-use|deep-research|antigravity)(?:-|$)/i;

export function getGeminiChatModels(rows) {
  const models = new Map();
  for (const row of rows) {
    const id = /^models\/([\w.-]+)$/.exec(row?.name)?.[1];
    if (!id || models.has(id) || !Array.isArray(row.supportedGenerationMethods)
      || !row.supportedGenerationMethods.includes("generateContent") || SPECIALIZED_MODELS.test(id)) continue;
    const capabilities = { ...getCapabilitiesForModel("gemini", id) };
    if (Number.isSafeInteger(row.inputTokenLimit) && row.inputTokenLimit > 0) capabilities.contextWindow = row.inputTokenLimit;
    if (Number.isSafeInteger(row.outputTokenLimit) && row.outputTokenLimit > 0) capabilities.maxOutput = row.outputTokenLimit;
    models.set(id, { id, name: row.displayName || id, kind: "llm", capabilities });
  }
  return [...models.values()];
}
