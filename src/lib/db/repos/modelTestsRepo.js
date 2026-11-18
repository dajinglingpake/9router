import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const RESULT_TTL_MS = 60 * 60 * 1000;

export async function getModelTests(scopes) {
  if (!scopes.length) return new Map();
  const db = await getAdapter();
  const rows = db.all(`SELECT scope, key, value FROM kv WHERE scope IN (${scopes.map(() => "?").join(", ")})`, scopes);
  const byScope = new Map();
  const now = Date.now();
  for (const row of rows) {
    const result = parseJson(row.value, null);
    if (!result || !["ok", "error"].includes(result.status) || !Number.isFinite(result.testedAt)
      || result.testedAt > now || now - result.testedAt >= RESULT_TTL_MS) continue;
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
