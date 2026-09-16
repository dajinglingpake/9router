import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function rowToCombo(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    models: parseJson(row.models, []),
    accountOverrides: parseJson(row.accountOverrides, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const COMBO_SELECT = `SELECT combos.*, kv.value AS accountOverrides FROM combos
  LEFT JOIN kv ON kv.scope = 'comboAccountOverrides' AND kv.key = combos.id`;

export async function getCombos() {
  const db = await getAdapter();
  const rows = db.all(`${COMBO_SELECT} ORDER BY combos.createdAt ASC`);
  return rows.map(rowToCombo);
}

export async function getComboById(id) {
  const db = await getAdapter();
  const row = db.get(`${COMBO_SELECT} WHERE combos.id = ?`, [id]);
  return rowToCombo(row);
}

export async function getComboByName(name) {
  const db = await getAdapter();
  const row = db.get(`${COMBO_SELECT} WHERE combos.name = ?`, [name]);
  return rowToCombo(row);
}

export async function createCombo(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const combo = {
    id: uuidv4(),
    name: data.name,
    kind: data.kind || null,
    models: data.models || [],
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
    [combo.id, combo.name, combo.kind, stringifyJson(combo.models), combo.createdAt, combo.updatedAt]
  );
  return combo;
}

export async function updateCombo(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`${COMBO_SELECT} WHERE combos.id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToCombo(row), ...data, updatedAt: new Date().toISOString() };
    db.run(
      `UPDATE combos SET name = ?, kind = ?, models = ?, updatedAt = ? WHERE id = ?`,
      [merged.name, merged.kind, stringifyJson(merged.models || []), merged.updatedAt, id]
    );
    if (data.accountOverrides !== undefined) {
      db.run(`INSERT INTO kv(scope, key, value) VALUES('comboAccountOverrides', ?, ?)
        ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`, [id, stringifyJson(data.accountOverrides)]);
    }
    result = merged;
  });
  return result;
}

export async function deleteCombo(id) {
  const db = await getAdapter();
  let deleted = false;
  db.transaction(() => {
    const res = db.run(`DELETE FROM combos WHERE id = ?`, [id]);
    deleted = (res?.changes ?? 0) > 0;
    db.run(`DELETE FROM kv WHERE scope = 'comboAccountOverrides' AND key = ?`, [id]);
  });
  return deleted;
}
