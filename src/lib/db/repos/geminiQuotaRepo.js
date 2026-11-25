import { getAdapter } from "../driver.js";

// Keep enough history for the longest Pacific day and the sliding minute at midnight.
const retentionMs = 26 * 60 * 60 * 1000;
const addReceipt = `INSERT INTO kv(scope, key, value) VALUES (?, ?, '1')
  ON CONFLICT(scope, key) DO UPDATE SET value = CAST(kv.value AS INTEGER) + 1`;

function hasUpstreamResponse(data) {
  if (data.source !== "upstream") return false;
  if (data.upstreamStatus >= 100 && data.upstreamStatus <= 599) return true;
  // Older terminal HTTP errors stored Google's body without the upstream status.
  try {
    const code = JSON.parse(data.message)?.error?.code;
    return code >= 400 && code <= 599 && code === data.statusCode;
  } catch { return false; }
}

export function geminiReceiptScope(db, connectionId, now) {
  const scope = `geminiQuotaReceipts:${connectionId}`;
  if (db.get("SELECT 1 FROM kv WHERE scope = ? AND key = '!imported'", [scope])) return scope;
  db.transaction(() => {
    const inserted = db.run("INSERT OR IGNORE INTO kv(scope, key, value) VALUES (?, '!imported', '1')", [scope]);
    if (!inserted.changes) return;
    const errors = db.all(`SELECT timestamp, model, data FROM requestErrors
      WHERE provider = 'gemini' AND connectionId = ? AND timestamp BETWEEN ? AND ?`,
    [connectionId, now.getTime() - retentionMs, now.getTime()]);
    // The error log already deduplicates the outer summary for the same failed attempt.
    for (const row of errors) {
      if (row.model && hasUpstreamResponse(JSON.parse(row.data))) {
        db.run(addReceipt, [scope, `${new Date(row.timestamp).toISOString()}/${row.model}`]);
      }
    }
  });
  return scope;
}

export async function recordGeminiQuotaResponse(connectionId, model, now = new Date()) {
  const db = await getAdapter();
  const scope = geminiReceiptScope(db, connectionId, now);
  db.transaction(() => {
    db.run(addReceipt, [scope, `${now.toISOString()}/${model}`]);
    db.run("DELETE FROM kv WHERE scope = ? AND key >= '0' AND key < ?", [scope, new Date(now.getTime() - retentionMs).toISOString()]);
  });
}
