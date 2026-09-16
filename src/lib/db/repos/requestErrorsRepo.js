import { getRequestLogContext } from "../../requestCaller.js";
import { getAdapter } from "../driver.js";
import { getRequestErrorInfo } from "../../requestErrorInfo.js";
import { safeDiagnosticMessage } from "open-sse/utils/upstreamDiagnostics.js";
import { DIAGNOSTIC_RESPONSE_HEADERS } from "open-sse/config/errorConfig.js";
import { notifyRequestError } from "../../alerts/wecom.js";

// Serialize inserts, recovery updates and clearing so earlier writes cannot reappear after clearing.
const state = globalThis._requestErrorWrites ||= { pending: Promise.resolve() };
function write(operation) {
  const result = state.pending.then(async () => operation(await getAdapter()));
  state.pending = result.catch(() => {});
  return result;
}

export function saveRequestError(entry) {
  const info = getRequestErrorInfo(entry);
  if (!info) return Promise.resolve(null);
  const record = {
    ...getRequestLogContext(entry),
    timestamp: entry.timestamp || Date.now(),
    connectionId: entry.connectionId || null, provider: entry.provider || null, model: entry.model || null,
    requestId: entry.requestId || null, retryCount: entry.retryCount || 0,
    status: String(entry.status), source: entry.source || "upstream", endpoint: entry.endpoint || null,
    transient: !!entry.transient, recovered: !!entry.recovered,
    message: safeDiagnosticMessage(entry.message), upstreamStatus: entry.upstreamStatus || null,
    sseAttempt: entry.sseAttempt || 1, attempt: entry.attempt || 1,
    headers: Object.fromEntries(Object.entries(entry.headers || {})
      .filter(([key]) => DIAGNOSTIC_RESPONSE_HEADERS.includes(key.toLowerCase()))
      .map(([key, value]) => [key, safeDiagnosticMessage(value)])),
    ...info,
  };
  return write(db => {
    // Skip the outer 503 summary when the actual failed attempt is already stored.
    if (!record.transient && record.statusCode === 503 && record.requestId && db.get(
      `SELECT id FROM requestErrors WHERE requestId = ? AND connectionId IS ? AND provider IS ? AND model IS ? AND retryCount = ? AND transient = 1 LIMIT 1`,
      [record.requestId, record.connectionId, record.provider, record.model, record.retryCount]
    )) return null;
    const result = db.run(
      `INSERT INTO requestErrors(timestamp, connectionId, provider, model, category, requestId, retryCount, transient, recovered, data) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.timestamp, record.connectionId, record.provider, record.model, record.category, record.requestId, record.retryCount, Number(record.transient), Number(record.recovered), JSON.stringify(record)]
    );
    // Delivery runs separately; network failures must never block requests or log writes.
    void notifyRequestError(record).catch(() => console.warn("[Alerts] Unable to queue request alert"));
    return Number(result.lastInsertRowid);
  });
}

export async function markRequestErrorsRecovered(writes) {
  const ids = (await Promise.all(writes)).filter(id => id != null);
  if (!ids.length) return;
  return write(db => db.transaction(() => {
    // UPDATE only: an already-cleared error must never be inserted again.
    for (const id of ids) db.run(`UPDATE requestErrors SET recovered = 1 WHERE id = ?`, [id]);
  }));
}

function whereFilter(filter = {}) {
  const clauses = [], params = [];
  for (const key of ["connectionId", "provider", "model", "category"]) {
    if (filter[key]) { clauses.push(`${key} = ?`); params.push(String(filter[key])); }
  }
  if (filter.beforeId != null) {
    const id = Number(filter.beforeId);
    if (!Number.isSafeInteger(id) || id < 0) throw new Error("Invalid log boundary");
    clauses.push("id <= ?"); params.push(id);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export async function getRequestErrors(filter = {}) {
  await state.pending;
  const db = await getAdapter();
  const where = whereFilter(filter);
  const limit = Math.floor(Math.min(100, Math.max(1, Number(filter.limit) || 50)));
  const rows = db.all(`SELECT id, data, recovered FROM requestErrors ${where.sql} ORDER BY id DESC LIMIT ?`, [...where.params, limit + 1]);
  const total = db.get(`SELECT COUNT(*) AS count FROM requestErrors ${where.sql}`, where.params).count;
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    items: page.map(row => ({ ...JSON.parse(row.data), id: row.id, recovered: !!row.recovered })),
    total, beforeId: Number(filter.beforeId ?? page[0]?.id ?? 0),
    nextBeforeId: hasMore ? page.at(-1).id - 1 : null,
  };
}

export async function getRecentRequestErrorCount() {
  await state.pending;
  const db = await getAdapter();
  return db.get(`SELECT COUNT(*) AS count FROM requestErrors WHERE timestamp >= ? AND category != 'cancelled'`, [Date.now() - 5 * 60 * 1000]).count;
}

export function clearRequestErrors(filter) {
  if (filter?.beforeId == null) throw new Error("A log boundary is required");
  const where = whereFilter(filter);
  return write(db => ({ deleted: db.run(`DELETE FROM requestErrors ${where.sql}`, where.params).changes }));
}
