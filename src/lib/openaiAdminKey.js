export function normalizeOpenAIAdminKey(provider, input) {
  if (input === undefined) return {};
  if (provider !== "openai" || (input !== null && typeof input !== "string")) {
    return { error: "Admin Key 仅支持 OpenAI 账号，必须填写字符串或清除。" };
  }
  if (input === null) return { value: null };
  const value = input.trim();
  if (value.length > 1024 || /\s/.test(value)) {
    return { error: "Admin Key 格式无效，请检查是否完整复制。" };
  }
  // Blank keeps the saved credential; null explicitly removes it.
  return { value: value || undefined };
}
