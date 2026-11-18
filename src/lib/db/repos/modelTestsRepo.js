import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const PREFERENCES_SCOPE = "modelTestPreferences";

export async function getModelTestPreferences() {
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ?`, [PREFERENCES_SCOPE]);
  return new Map(rows.map(row => [row.key, parseJson(row.value, {})]));
}

export async function saveModelTestPreferences(provider, changes) {
  const db = await getAdapter();
  db.transaction(() => {
    const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [PREFERENCES_SCOPE, provider]);
    const preferences = { ...parseJson(row?.value, {}), ...changes };
    db.run(`INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
      ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`, [PREFERENCES_SCOPE, provider, stringifyJson(preferences)]);
  });
}

export async function getModelTests(scopes) {
  if (!scopes.length) return new Map();
  const db = await getAdapter();
  const rows = db.all(`SELECT scope, key, value FROM kv WHERE scope IN (${scopes.map(() => "?").join(", ")})`, scopes);
  const byScope = new Map();
  const now = Date.now();
  for (const row of rows) {
    const result = parseJson(row.value, null);
    if (!result || !["ok", "error"].includes(result.status) || !Number.isFinite(result.testedAt)
      || result.testedAt > now) continue;
    if (!byScope.has(row.scope)) byScope.set(row.scope, new Map());
    byScope.get(row.scope).set(row.key, result);
  }
  return byScope;
}

export async function saveModelTest(scope, model, result) {
  const db = await getAdapter();
  db.run(`INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
    ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`, [scope, model, stringifyJson(result)]);
}
