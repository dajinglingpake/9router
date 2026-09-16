import { OPENAI_BLOCK, CLAUDE_BLOCK, RESPONSES_ITEM } from "../translator/schema/blocks.js";

export const INPUT_TEXT_FIELDS = ["messages", "input", "prompt", "system", "instructions", "contents", "systemInstruction", "system_instruction"];
export const TOOL_DEFINITION_FIELDS = ["tools", "functions"];
export const OPAQUE_CONTENT_TYPES = new Set([
  OPENAI_BLOCK.IMAGE_URL, OPENAI_BLOCK.IMAGE, OPENAI_BLOCK.INPUT_AUDIO, OPENAI_BLOCK.AUDIO_URL,
  OPENAI_BLOCK.FILE, CLAUDE_BLOCK.DOCUMENT, CLAUDE_BLOCK.REDACTED_THINKING,
  RESPONSES_ITEM.INPUT_IMAGE, "input_file", "input_video", "video_url",
]);
export const ATTACHMENT_CONTENT_FIELDS = new Set(["inlineData", "inline_data", "fileData", "file_data"]);
export const OPAQUE_CONTENT_FIELDS = new Set([
  "encrypted_content", "reasoning_encrypted_content", "thoughtSignature", "thought_signature",
  ...ATTACHMENT_CONTENT_FIELDS, "cache_control",
]);
export const TEXT_CHARS_PER_TOKEN = 4;
export const INPUT_TOKEN_ESTIMATE_VERSION = 2;
export const TOKEN_ESTIMATE_FIELDS = [
  "estimatedInputTokens", "estimatedAttachmentTokens", "attachmentCount",
  "unestimatedAttachmentCount", "encryptedContextCount", "inputTokenEstimateVersion",
];
