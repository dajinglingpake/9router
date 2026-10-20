import { getAdapter } from "@/lib/db/driver.js";
import { APPEAL_RESULTS, APPEAL_NOTE_LIMIT } from "@/shared/utils/accountAppeals";

const THREADS = "accountAppealThreads", MESSAGES = "accountAppealMessages";
const fail = (message, status = 400) => Object.assign(new Error(message), { public: true, status });
export function validateHistoryId(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(value)) throw fail("申诉记录 ID 无效。");
  return value;
}
const keyFor = (account, thread) => `${validateHistoryId(account)}:${validateHistoryId(thread)}`;
const read = (db, scope, key) => { const row = db.get("SELECT value FROM kv WHERE scope = ? AND key = ?", [scope, key]); return row ? JSON.parse(row.value) : null; };
const write = (db, scope, key, value) => db.run("INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value", [scope, key, JSON.stringify(value)]);

export async function saveAppealMessages(connectionId, messages) {
  validateHistoryId(connectionId);
  const db = await getAdapter();
  return db.transaction(() => {
    for (const message of messages) {
      const key = keyFor(connectionId, message.threadId), messageKey = `${key}:${validateHistoryId(message.id)}`;
      if (!["user", "support"].includes(message.role) || typeof message.text !== "string" || !message.text) continue;
      const previous = read(db, MESSAGES, messageKey);
      if (previous?.complete && !message.complete || previous?.text === message.text && previous?.complete === message.complete) continue;
      const now = new Date().toISOString();
      const entry = { id: message.id, role: message.role, text: message.text, complete: !!message.complete, truncated: !!message.truncated,
        createdAt: message.createdAt || previous?.createdAt || now, capturedAt: now };
      write(db, MESSAGES, messageKey, entry);
      const thread = read(db, THREADS, key) || { id: message.threadId, connectionId, createdAt: entry.createdAt, messageCount: 0, userMessageCount: 0, result: null, note: "" };
      thread.createdAt = thread.createdAt < entry.createdAt ? thread.createdAt : entry.createdAt;
      thread.updatedAt = now;
      if (!previous) { thread.messageCount++; if (entry.role === "user") thread.userMessageCount++; }
      if (entry.role === "support" && (!thread.lastReplyAt || entry.createdAt >= thread.lastReplyAt)) {
        thread.lastReply = entry.text.slice(0, 300); thread.lastReplyAt = entry.createdAt;
      }
      write(db, THREADS, key, thread);
    }
  });
}

function rowsFor(db, scope, prefix) {
  return db.all("SELECT value FROM kv WHERE scope = ? AND key >= ? AND key < ?", [scope, prefix, `${prefix}\uffff`]).map(row => JSON.parse(row.value));
}

export async function getAppealSummaries() {
  const db = await getAdapter();
  const summaries = {};
  for (const row of db.all("SELECT value FROM kv WHERE scope = ?", [THREADS])) {
    const thread = JSON.parse(row.value), current = summaries[thread.connectionId];
    summaries[thread.connectionId] = { count: (current?.count || 0) + 1, latest: !current || thread.createdAt > current.latest.createdAt ? thread : current.latest };
  }
  return summaries;
}

export async function listAppealHistory(connectionId, offset = 0) {
  validateHistoryId(connectionId);
  const db = await getAdapter();
  const records = rowsFor(db, THREADS, `${connectionId}:`).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  return { items: records.slice(offset, offset + 20), total: records.length, hasMore: offset + 20 < records.length };
}

export async function getAppealHistory(connectionId, threadId) {
  const key = keyFor(connectionId, threadId), db = await getAdapter();
  const record = read(db, THREADS, key);
  if (!record) throw fail("申诉记录不存在。", 404);
  const messages = rowsFor(db, MESSAGES, `${key}:`).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.capturedAt.localeCompare(b.capturedAt) || a.id.localeCompare(b.id));
  return { ...record, messages };
}

export async function updateAppealResult(connectionId, threadId, input) {
  const key = keyFor(connectionId, threadId);
  if (input.result !== null && !Object.hasOwn(APPEAL_RESULTS, input.result)) throw fail("请选择有效的申诉处理结果。");
  if (typeof input.note !== "string" || input.note.length > APPEAL_NOTE_LIMIT) throw fail(`备注最多 ${APPEAL_NOTE_LIMIT} 个字符。`);
  const db = await getAdapter();
  return db.transaction(() => {
    const record = read(db, THREADS, key);
    if (!record) throw fail("申诉记录不存在。", 404);
    const updated = { ...record, result: input.result, note: input.note.trim(), resultUpdatedAt: new Date().toISOString() };
    write(db, THREADS, key, updated);
    return updated;
  });
}
