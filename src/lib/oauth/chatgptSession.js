export const chatgptSessionError = (message, status = 409) => Object.assign(new Error(message), { status });

export function parseChatgptSession(raw, connection = null) {
  let value;
  try { value = JSON.parse(raw); } catch { throw chatgptSessionError("网页 Session 尚未就绪，请继续完成登录。"); }
  if (!value || Array.isArray(value) || typeof value !== "object"
    || typeof value.accessToken !== "string" || !value.accessToken.trim()
    || typeof value.user?.email !== "string" || !value.user.email.trim()
    || typeof value.account?.id !== "string" || !value.account.id
    || typeof value.expires !== "string" || !Number.isFinite(Date.parse(value.expires))) {
    throw chatgptSessionError("网页 Session 尚未就绪，请继续完成登录。");
  }
  if (!connection) return value;
  const email = connection.email?.trim().toLowerCase();
  const data = connection.providerSpecificData || {};
  const accountId = data.workspaceId || data.accountId || data.chatgptAccountId;
  if (!email || value.user.email.trim().toLowerCase() !== email) {
    throw chatgptSessionError("网页登录邮箱与原账号不一致，请切换到原账号。");
  }
  if (accountId && value.account.id !== accountId) {
    throw chatgptSessionError("网页工作空间与原账号不一致，请在 ChatGPT 中切换工作空间。");
  }
  return value;
}

export function getRecordedChatgptSession(connection) {
  const record = connection.chatgptSession;
  if (typeof record?.raw !== "string") return null;
  try { return { ...record, session: parseChatgptSession(record.raw, connection) }; }
  catch { return null; }
}
