import { randomUUID } from "node:crypto";
import { getAdapter } from "../driver.js";
import { safeDiagnosticMessage } from "open-sse/utils/upstreamDiagnostics.js";

const HISTORY_SCOPE = "accountOverloadHistory";
const DISMISSED_SCOPE = "accountOverloadDismissed";
const OVERLOAD_FILTER = "connectionId = ? AND json_extract(data, '$.source') = 'upstream' AND json_extract(data, '$.statusCode') = 503";

function getDismissed(db, connectionId, fromLog = false) {
  const value = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [DISMISSED_SCOPE, connectionId])?.value;
  if (value?.startsWith("{")) return JSON.parse(value);
  const dismissed = { eventId: value, beforeId: 0 };
  const current = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [HISTORY_SCOPE, connectionId]);
  if (value && current && JSON.parse(current.value).eventId === value) {
    // Upgrade an old UUID-only dismissal before recording the next failure.
    const latestId = db.get(`SELECT MAX(id) AS id FROM requestErrors WHERE ${OVERLOAD_FILTER}`, [connectionId]).id || 0;
    dismissed.beforeId = Math.max(0, latestId - Number(fromLog));
    db.run(`UPDATE kv SET value = ? WHERE scope = ? AND key = ?`, [JSON.stringify(dismissed), DISMISSED_SCOPE, connectionId]);
  }
  return dismissed;
}

function retainedCount(db, connectionId, beforeId) {
  return db.get(`SELECT COUNT(*) AS count FROM requestErrors WHERE ${OVERLOAD_FILTER} AND id > ?`, [connectionId, beforeId]).count;
}

export function recordAccountOverloadWarning(db, connectionId, lastAt, fromLog = false) {
  const timestamp = new Date(lastAt).getTime();
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [HISTORY_SCOPE, connectionId]);
  const previous = row ? JSON.parse(row.value) : null;
  // Only the actual error-log insert increments the counter. The health update
  // for the same attempt must not count it twice, regardless of write order.
  const count = Number.isSafeInteger(previous?.count)
    ? previous.count + Number(fromLog)
    : retainedCount(db, connectionId, getDismissed(db, connectionId, fromLog).beforeId);
  const warning = { eventId: randomUUID(), lastAt: Number.isFinite(timestamp) ? timestamp : Date.now(), count };
  db.run(`INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
    ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`, [HISTORY_SCOPE, connectionId, JSON.stringify(warning)]);
  return warning;
}

export async function getAccountOverloadWarnings(connectionId) {
  await globalThis._requestErrorWrites?.pending;
  const db = await getAdapter();
  const warnings = {};
  db.transaction(() => {
    const accounts = db.all(`SELECT id, data FROM providerConnections ${connectionId ? "WHERE id = ?" : ""}`, connectionId ? [connectionId] : []);
    const history = new Map(db.all(`SELECT key, value FROM kv WHERE scope = ?`, [HISTORY_SCOPE]).map(row => [row.key, JSON.parse(row.value)]));
    for (const account of accounts) {
      let warning = history.get(account.id);
      const dismissed = getDismissed(db, account.id);
      if (!warning) {
        // Seed retained history once, including older SSE failures only stored in account health.
        const error = db.get(`SELECT timestamp FROM requestErrors WHERE ${OVERLOAD_FILTER}
          ORDER BY id DESC LIMIT 1`, [account.id]);
        const data = JSON.parse(account.data || "{}");
        const legacyAt = data.errorCode === 503 ? new Date(data.lastErrorAt).getTime() : 0;
        const lastAt = Math.max(error?.timestamp || 0, Number.isFinite(legacyAt) ? legacyAt : 0);
        if (lastAt > 0) warning = recordAccountOverloadWarning(db, account.id, lastAt);
      }
      if (!warning || dismissed.eventId === warning.eventId) continue;
      if (!Number.isSafeInteger(warning.count)) {
        warning.count = retainedCount(db, account.id, dismissed.beforeId);
        db.run(`UPDATE kv SET value = ? WHERE scope = ? AND key = ?`, [JSON.stringify(warning), HISTORY_SCOPE, account.id]);
      }
      warnings[account.id] = { ...warning, count: Math.max(1, warning.count) };
    }
  });
  return warnings;
}

export async function dismissAccountOverloadWarning(connectionId, eventId) {
  await globalThis._requestErrorWrites?.pending;
  const db = await getAdapter();
  db.transaction(() => {
    const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [HISTORY_SCOPE, connectionId]);
    // An older clear cannot hide a newer overload or undo a newer dismissal.
    if (!row || JSON.parse(row.value).eventId !== eventId) return;
    const beforeId = db.get(`SELECT MAX(id) AS id FROM requestErrors WHERE ${OVERLOAD_FILTER}`, [connectionId]).id || 0;
    db.run(`INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
      ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`, [DISMISSED_SCOPE, connectionId, JSON.stringify({ eventId, beforeId })]);
    db.run(`UPDATE kv SET value = ? WHERE scope = ? AND key = ?`, [JSON.stringify({ ...JSON.parse(row.value), count: 0 }), HISTORY_SCOPE, connectionId]);
  });
}

export async function getAccountOverloadDetails(connectionId) {
  const warnings = await getAccountOverloadWarnings(connectionId);
  const overloadWarning = warnings[connectionId] || null;
  if (!overloadWarning) return { overloadWarning, items: [], hasMore: false };
  const db = await getAdapter();
  // Keep the warning snapshot and its details consistent if a new attempt is
  // logged while the adapter is being acquired.
  return db.transaction(() => {
    const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [HISTORY_SCOPE, connectionId]);
    const current = JSON.parse(row.value);
    const dismissed = getDismissed(db, connectionId);
    if (dismissed.eventId === current.eventId) return { overloadWarning: null, items: [], hasMore: false };
    const count = retainedCount(db, connectionId, dismissed.beforeId);
    const items = db.all(`SELECT id, timestamp, provider, model, recovered, data FROM requestErrors
      WHERE ${OVERLOAD_FILTER} AND id > ? ORDER BY id DESC LIMIT 50`, [connectionId, dismissed.beforeId]).map(error => {
      const data = JSON.parse(error.data);
      return { id: error.id, timestamp: error.timestamp, provider: error.provider, model: error.model,
        recovered: !!error.recovered, statusCode: 503, upstreamStatus: data.upstreamStatus,
        message: safeDiagnosticMessage(data.message) };
    });
    return { overloadWarning: { ...current, count: Math.max(1, current.count) }, items, hasMore: count > items.length };
  });
}
