function toAccounts(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") {
    return Array.isArray(value.accounts) ? value.accounts : [value];
  }
  throw new Error("请输入账号 JSON 或 Access Token。");
}

export function parseCodexImportText(input) {
  const text = input.trim();
  if (!text) return [];
  if (/^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text)) {
    return [{ accessToken: text }];
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { /* Multiple JSON documents are read below. */ }
  if (parsed !== undefined) return toAccounts(parsed);

  const accounts = [];
  let cursor = 0, number = 0;
  while (cursor < text.length) {
    while (/\s/.test(text[cursor] || "")) cursor++;
    if (cursor === text.length) break;
    number++;
    const invalid = () => new Error(`第 ${number} 段 JSON 格式无效，请检查内容是否完整。`);
    if (text[cursor] !== "{" && text[cursor] !== "[") throw invalid();

    const start = cursor;
    let depth = 0, quoted = false, escaped = false;
    // Braces inside JSON strings do not end a document.
    for (; cursor < text.length; cursor++) {
      const char = text[cursor];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") {
        depth--;
        if (depth === 0) { cursor++; break; }
      }
    }
    let value;
    try { value = JSON.parse(text.slice(start, cursor)); } catch { throw invalid(); }
    accounts.push(...toAccounts(value));
    while (/\s/.test(text[cursor] || "")) cursor++;
    if (text[cursor] === ",") {
      cursor++;
      if (!text.slice(cursor).trim()) throw invalid();
    }
  }
  return accounts;
}
