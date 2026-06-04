import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const FILTER_COLUMNS = {
  provider: "provider",
  model: "model",
  connectionId: "connectionId",
  clientIp: "clientIp",
  status: "status",
};

function compactString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTimestamp(value) {
  const raw = compactString(value);
  if (!raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function normalizeAuditLogFilter(input = {}) {
  const filter = { all: input.all === true };

  const before = normalizeTimestamp(input.before || input.beforeTimestamp);
  const after = normalizeTimestamp(input.after || input.afterTimestamp);
  if (before) filter.before = before;
  if (after) filter.after = after;

  for (const key of Object.keys(FILTER_COLUMNS)) {
    const value = compactString(input[key]);
    if (value) filter[key] = value;
  }

  const hasCondition = filter.before || filter.after || Object.keys(FILTER_COLUMNS).some((key) => filter[key]);
  if (!filter.all && !hasCondition) {
    throw new Error("At least one cleanup condition is required");
  }

  if (filter.all && hasCondition) {
    throw new Error("Use either all=true or filter conditions, not both");
  }

  return filter;
}

function buildWhere(filter) {
  if (filter.all) return { sql: "", params: [] };

  const clauses = [];
  const params = [];
  if (filter.before) { clauses.push("timestamp < ?"); params.push(filter.before); }
  if (filter.after) { clauses.push("timestamp >= ?"); params.push(filter.after); }

  for (const [key, column] of Object.entries(FILTER_COLUMNS)) {
    if (filter[key]) { clauses.push(`${column} = ?`); params.push(filter[key]); }
  }

  return { sql: `WHERE ${clauses.join(" AND ")}`, params };
}

function getLocalDateKey(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addToCounter(target, key, values) {
  if (!target[key]) target[key] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
  target[key].requests += values.requests || 1;
  target[key].promptTokens += values.promptTokens || 0;
  target[key].completionTokens += values.completionTokens || 0;
  target[key].cost += values.cost || 0;
  if (values.meta) Object.assign(target[key], values.meta);
}

function aggregateUsageRow(day, row) {
  const tokens = parseJson(row.tokens, {}) || {};
  const promptTokens = row.promptTokens || tokens.prompt_tokens || tokens.input_tokens || 0;
  const completionTokens = row.completionTokens || tokens.completion_tokens || tokens.output_tokens || 0;
  const cost = row.cost || 0;
  const vals = { promptTokens, completionTokens, cost };

  day.requests = (day.requests || 0) + 1;
  day.promptTokens = (day.promptTokens || 0) + promptTokens;
  day.completionTokens = (day.completionTokens || 0) + completionTokens;
  day.cost = (day.cost || 0) + cost;

  day.byProvider ||= {};
  day.byModel ||= {};
  day.byAccount ||= {};
  day.byApiKey ||= {};
  day.byEndpoint ||= {};
  day.byClientIp ||= {};

  if (row.provider) addToCounter(day.byProvider, row.provider, vals);

  const modelKey = row.provider ? `${row.model}|${row.provider}` : row.model;
  addToCounter(day.byModel, modelKey, { ...vals, meta: { rawModel: row.model, provider: row.provider } });

  if (row.connectionId) {
    addToCounter(day.byAccount, row.connectionId, { ...vals, meta: { rawModel: row.model, provider: row.provider } });
  }

  const apiKeyVal = row.apiKey && typeof row.apiKey === "string" ? row.apiKey : "local-no-key";
  const akModelKey = `${apiKeyVal}|${row.model}|${row.provider || "unknown"}`;
  addToCounter(day.byApiKey, akModelKey, { ...vals, meta: { rawModel: row.model, provider: row.provider, apiKey: row.apiKey || null } });

  const clientIp = row.clientIp || "unknown";
  const ipKey = `${clientIp}|${apiKeyVal}|${row.model}|${row.provider || "unknown"}`;
  addToCounter(day.byClientIp, ipKey, { ...vals, meta: { clientIp, rawModel: row.model, provider: row.provider, apiKey: row.apiKey || null } });

  const endpoint = row.endpoint || "Unknown";
  const epKey = `${endpoint}|${row.model}|${row.provider || "unknown"}`;
  addToCounter(day.byEndpoint, epKey, { ...vals, meta: { endpoint, rawModel: row.model, provider: row.provider } });
}

function rebuildUsageDaily(db) {
  const rows = db.all(
    `SELECT timestamp, provider, model, connectionId, apiKey, endpoint, clientIp, promptTokens, completionTokens, cost, tokens FROM usageHistory ORDER BY id ASC`
  );
  const days = {};
  for (const row of rows) {
    const dateKey = getLocalDateKey(row.timestamp);
    days[dateKey] ||= {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
      byProvider: {},
      byModel: {},
      byAccount: {},
      byApiKey: {},
      byEndpoint: {},
      byClientIp: {},
    };
    aggregateUsageRow(days[dateKey], row);
  }

  db.run(`DELETE FROM usageDaily`);
  for (const [dateKey, day] of Object.entries(days)) {
    db.run(`INSERT INTO usageDaily(dateKey, data) VALUES(?, ?)`, [dateKey, stringifyJson(day)]);
  }
  return Object.keys(days).length;
}

export async function clearAuditLogs(input = {}) {
  const filter = normalizeAuditLogFilter(input);
  const where = buildWhere(filter);
  const db = await getAdapter();

  let result;
  db.transaction(() => {
    const usageCount = db.get(`SELECT COUNT(*) as c FROM usageHistory ${where.sql}`, where.params)?.c || 0;
    const detailCount = db.get(`SELECT COUNT(*) as c FROM requestDetails ${where.sql}`, where.params)?.c || 0;

    db.run(`DELETE FROM usageHistory ${where.sql}`, where.params);
    db.run(`DELETE FROM requestDetails ${where.sql}`, where.params);
    const usageDailyRows = rebuildUsageDaily(db);

    result = {
      filter,
      deleted: {
        usageHistory: usageCount,
        requestDetails: detailCount,
      },
      usageDailyRows,
    };
  });

  if (global._recentRing) {
    global._recentRing.items = [];
    global._recentRing.initialized = false;
  }
  try {
    const { statsEmitter } = await import("./usageRepo.js");
    statsEmitter.emit("update");
  } catch {}
  if (typeof db.checkpoint === "function") db.checkpoint();

  return result;
}
