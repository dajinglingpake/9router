import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import {
  isIpAllowed,
  mergeClaimAllowedIps,
  normalizeApiKeyName,
  parseAllowedIps,
  serializeAllowedIps,
} from "../../apiKeys/accessPolicy.js";

const LIMIT_SCOPE = "apiKeyConcurrency";

function normalizeConcurrencyLimit(value) {
  const limit = Number.parseInt(value, 10);
  return Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 0;
}

function readConcurrencyLimit(db, id) {
  if (!id) return 0;
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [LIMIT_SCOPE, id]);
  return normalizeConcurrencyLimit(row?.value);
}

function rowToKey(row, maxConcurrentRequests = 0) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    claimedAt: row.claimedAt || null,
    allowedIps: parseAllowedIps(row.allowedIps),
    maxConcurrentRequests: normalizeConcurrencyLimit(maxConcurrentRequests),
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  const limits = new Map(
    db.all(`SELECT key, value FROM kv WHERE scope = ?`, [LIMIT_SCOPE])
      .map((row) => [row.key, normalizeConcurrencyLimit(row.value)])
  );
  return rows.map((row) => rowToKey(row, limits.get(row.id)));
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row, readConcurrencyLimit(db, id));
}

export async function getApiKeyByValue(key) {
  const normalizedKey = typeof key === "string" ? key.trim() : "";
  if (!normalizedKey) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [normalizedKey]);
  return rowToKey(row, readConcurrencyLimit(db, row?.id));
}

export async function getApiKeyByName(name) {
  const normalizedName = normalizeApiKeyName(name);
  if (!normalizedName) return null;
  const db = await getAdapter();
  const row = db.get(
    `SELECT * FROM apiKeys WHERE lower(name) = lower(?) ORDER BY createdAt ASC LIMIT 1`,
    [normalizedName]
  );
  return rowToKey(row, readConcurrencyLimit(db, row?.id));
}

export async function claimApiKeyByName(name, clientIp, requestedAllowedIps = []) {
  const normalizedName = normalizeApiKeyName(name);
  if (!normalizedName) return { status: "invalid" };
  const allowedIps = mergeClaimAllowedIps(clientIp, requestedAllowedIps);
  if (!allowedIps) return { status: "invalid_ip" };
  const db = await getAdapter();

  let result = null;
  db.transaction(() => {
    const row = db.get(
      `SELECT * FROM apiKeys WHERE lower(name) = lower(?) ORDER BY createdAt ASC LIMIT 1`,
      [normalizedName]
    );
    const apiKey = rowToKey(row, readConcurrencyLimit(db, row?.id));
    if (!apiKey) {
      result = { status: "not_found", username: normalizedName };
      return;
    }
    if (!apiKey.isActive) {
      result = { status: "disabled", apiKey };
      return;
    }
    if (apiKey.claimedAt) {
      result = { status: "already_claimed", apiKey };
      return;
    }

    const claimedAt = new Date().toISOString();
    db.run(`UPDATE apiKeys SET claimedAt = ?, allowedIps = ? WHERE id = ? AND claimedAt IS NULL`, [claimedAt, serializeAllowedIps(allowedIps), apiKey.id]);
    result = { status: "claimed", apiKey: { ...apiKey, claimedAt, allowedIps } };
  });

  return result;
}

export async function createApiKey(name, machineId, maxConcurrentRequests = 0) {
  if (!machineId) throw new Error("machineId is required");
  const normalizedName = normalizeApiKeyName(name);
  if (!normalizedName) throw new Error("name is required");
  const db = await getAdapter();
  const existing = db.get(
    `SELECT id FROM apiKeys WHERE lower(name) = lower(?) LIMIT 1`,
    [normalizedName]
  );
  if (existing) throw new Error("api key name already exists");
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name: normalizedName,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
    claimedAt: null,
    allowedIps: [],
    maxConcurrentRequests: normalizeConcurrencyLimit(maxConcurrentRequests),
  };
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, claimedAt, allowedIps) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt, apiKey.claimedAt, serializeAllowedIps(apiKey.allowedIps)]
  );
  if (apiKey.maxConcurrentRequests > 0) {
    db.run(
      `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
      [LIMIT_SCOPE, apiKey.id, String(apiKey.maxConcurrentRequests)]
    );
  }
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row, readConcurrencyLimit(db, id)), ...data };
    const allowedIps = data.allowedIps !== undefined ? parseAllowedIps(data.allowedIps) : merged.allowedIps;
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, allowedIps = ? WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, serializeAllowedIps(allowedIps), id]
    );
    const maxConcurrentRequests = normalizeConcurrencyLimit(merged.maxConcurrentRequests);
    if (maxConcurrentRequests > 0) {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [LIMIT_SCOPE, id, String(maxConcurrentRequests)]
      );
    } else {
      db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [LIMIT_SCOPE, id]);
    }
    result = { ...merged, allowedIps, maxConcurrentRequests };
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  let deleted = false;
  db.transaction(() => {
    const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
    db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [LIMIT_SCOPE, id]);
    deleted = (res?.changes ?? 0) > 0;
  });
  return deleted;
}

export async function validateApiKey(key, clientIp = null) {
  const normalizedKey = typeof key === "string" ? key.trim() : "";
  if (!normalizedKey) return false;
  const db = await getAdapter();
  const row = db.get(`SELECT isActive, allowedIps FROM apiKeys WHERE key = ?`, [normalizedKey]);
  if (!row) return false;
  if (!(row.isActive === 1 || row.isActive === true)) return false;
  return isIpAllowed(row.allowedIps, clientIp);
}
