import { randomUUID } from "node:crypto";
import { getAdapter } from "../driver.js";

const HISTORY_SCOPE = "accountOverloadHistory";
const DISMISSED_SCOPE = "accountOverloadDismissed";

export function recordAccountOverloadWarning(db, connectionId, lastAt) {
  const timestamp = new Date(lastAt).getTime();
  const warning = { eventId: randomUUID(), lastAt: Number.isFinite(timestamp) ? timestamp : Date.now() };
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
    const dismissed = new Map(db.all(`SELECT key, value FROM kv WHERE scope = ?`, [DISMISSED_SCOPE]).map(row => [row.key, row.value]));
    for (const account of accounts) {
      let warning = history.get(account.id);
      if (!warning) {
        // Seed retained history once, including older SSE failures only stored in account health.
        const error = db.get(`SELECT timestamp FROM requestErrors WHERE connectionId = ?
          AND json_extract(data, '$.source') = 'upstream' AND json_extract(data, '$.statusCode') = 503
          ORDER BY id DESC LIMIT 1`, [account.id]);
        const data = JSON.parse(account.data || "{}");
        const legacyAt = data.errorCode === 503 ? new Date(data.lastErrorAt).getTime() : 0;
        const lastAt = Math.max(error?.timestamp || 0, Number.isFinite(legacyAt) ? legacyAt : 0);
        if (lastAt > 0) warning = recordAccountOverloadWarning(db, account.id, lastAt);
      }
      if (warning && dismissed.get(account.id) !== warning.eventId) warnings[account.id] = warning;
    }
  });
  return warnings;
}

export async function dismissAccountOverloadWarning(connectionId, eventId) {
  const db = await getAdapter();
  db.transaction(() => {
    const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [HISTORY_SCOPE, connectionId]);
    // An older clear cannot hide a newer overload or undo a newer dismissal.
    if (!row || JSON.parse(row.value).eventId !== eventId) return;
    db.run(`INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
      ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`, [DISMISSED_SCOPE, connectionId, eventId]);
  });
}
