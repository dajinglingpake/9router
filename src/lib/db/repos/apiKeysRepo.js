import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import {
  isIpAllowed,
  mergeClaimAllowedIps,
  normalizeApiKeyName,
  parseAllowedIps,
  serializeAllowedIps,
} from "../../apiKeys/accessPolicy.js";

function rowToKey(row) {
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
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function getApiKeyByName(name) {
  const normalizedName = normalizeApiKeyName(name);
  if (!normalizedName) return null;
  const db = await getAdapter();
  const row = db.get(
    `SELECT * FROM apiKeys WHERE lower(name) = lower(?) ORDER BY createdAt ASC LIMIT 1`,
    [normalizedName]
  );
  return rowToKey(row);
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
    const apiKey = rowToKey(row);
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

export async function createApiKey(name, machineId) {
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
  };
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, claimedAt, allowedIps) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt, apiKey.claimedAt, serializeAllowedIps(apiKey.allowedIps)]
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    const allowedIps = data.allowedIps !== undefined ? parseAllowedIps(data.allowedIps) : merged.allowedIps;
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, allowedIps = ? WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, serializeAllowedIps(allowedIps), id]
    );
    result = { ...merged, allowedIps };
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
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
