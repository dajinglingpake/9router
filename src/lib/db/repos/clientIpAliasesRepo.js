import { getAdapter } from "../driver.js";

function normalizeIp(ip) {
  return typeof ip === "string" ? ip.trim() : "";
}

function normalizeAlias(alias) {
  return typeof alias === "string" ? alias.trim() : "";
}

export async function getClientIpAliases() {
  const db = await getAdapter();
  return db.all(
    `SELECT ip, alias, createdAt, updatedAt FROM clientIpAliases ORDER BY alias COLLATE NOCASE ASC, ip ASC`
  );
}

export async function getClientIpAliasMap() {
  const rows = await getClientIpAliases();
  const map = {};
  for (const row of rows) map[row.ip] = row.alias;
  return map;
}

export async function setClientIpAlias(ip, alias) {
  const normalizedIp = normalizeIp(ip);
  const normalizedAlias = normalizeAlias(alias);
  if (!normalizedIp) throw new Error("Client IP is required");

  const db = await getAdapter();
  if (!normalizedAlias) {
    db.run(`DELETE FROM clientIpAliases WHERE ip = ?`, [normalizedIp]);
    return { ip: normalizedIp, alias: "" };
  }

  const now = new Date().toISOString();
  db.run(
    `INSERT INTO clientIpAliases(ip, alias, createdAt, updatedAt) VALUES(?, ?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET alias = excluded.alias, updatedAt = excluded.updatedAt`,
    [normalizedIp, normalizedAlias, now, now]
  );
  return { ip: normalizedIp, alias: normalizedAlias };
}

export async function deleteClientIpAlias(ip) {
  const normalizedIp = normalizeIp(ip);
  if (!normalizedIp) throw new Error("Client IP is required");
  const db = await getAdapter();
  db.run(`DELETE FROM clientIpAliases WHERE ip = ?`, [normalizedIp]);
  return { ip: normalizedIp, alias: "" };
}
