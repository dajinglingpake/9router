import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSqlJsAdapter } from "../../src/lib/db/adapters/sqljsAdapter.js";
import { TABLES, buildCreateTableSql } from "../../src/lib/db/schema.js";

const state = vi.hoisted(() => ({ db: null }));
vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: async () => state.db }));
vi.mock("@/lib/localDb", async () => ({
  ...await import("../../src/lib/db/repos/combosRepo.js"),
  getProviderConnectionById: async id => ["a", "b"].includes(id) ? { id, provider: "codex" } : null,
  getModelAliases: async () => ({}),
  getProviderNodes: async () => [],
}));
import { createCombo, updateCombo, getComboById, getComboByName, getCombos, deleteCombo } from "../../src/lib/db/repos/combosRepo.js";
import { getComboAccountModels } from "../../src/sse/services/model.js";
import { PUT } from "../../src/app/api/combos/[id]/route.js";

let tempDir, file;
beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-combos-"));
  file = path.join(tempDir, "test.sqlite");
  state.db = await createSqlJsAdapter(file);
  for (const [name, def] of Object.entries(TABLES)) state.db.exec(buildCreateTableSql(name, def));
});
afterEach(() => {
  state.db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
const update = (id, body) => PUT(new Request(`http://localhost/api/combos/${id}`, {
  method: "PUT", body: JSON.stringify(body),
}), { params: Promise.resolve({ id }) });

it("persists account overrides independently of common edits and keeps them through renames", async () => {
  const combo = await createCombo({ name: "test-combo", models: ["codex/common"] });
  expect((await update(combo.id, { accountOverrides: { a: ["codex/cheap"] } })).status).toBe(200);
  await updateCombo(combo.id, { name: "renamed", models: ["codex/common-v2"] });
  state.db.close();
  state.db = await createSqlJsAdapter(file);
  const saved = await getComboByName("renamed");
  expect(saved).toMatchObject({ models: ["codex/common-v2"], accountOverrides: { a: ["codex/cheap"] } });
  expect((await getCombos())[0]).toEqual(saved);
  expect(await getComboAccountModels(["cc/renamed"], "codex")).toEqual({ a: "cheap" });
  expect(await getComboAccountModels(["renamed"], "deepseek")).toEqual({});
  expect((await update(combo.id, { accountOverrides: {} })).status).toBe(200);
  expect((await getComboById(combo.id)).accountOverrides).toEqual({});
  expect(await getComboAccountModels(["renamed"], "codex")).toEqual({});
});

it("resolves nested defaults with the outer combo taking precedence", async () => {
  const inner = await createCombo({ name: "inner", models: ["codex/common"] });
  const outer = await createCombo({ name: "outer", models: ["inner"] });
  await updateCombo(inner.id, { accountOverrides: { a: ["codex/inner"], b: ["codex/inner-b"] } });
  await updateCombo(outer.id, { accountOverrides: { a: ["codex/outer"] } });
  expect(await getComboAccountModels(["outer", "inner"], "codex")).toEqual({ a: "outer", b: "inner-b" });
  await deleteCombo(outer.id);
  expect(state.db.get("SELECT value FROM kv WHERE scope = 'comboAccountOverrides' AND key = ?", [outer.id])).toBeFalsy();
  expect((await getComboById(inner.id)).accountOverrides.b).toEqual(["codex/inner-b"]);
});

it.each([
  null, [], { missing: ["codex/cheap"] }, { a: [] }, { a: "codex/cheap" },
  { a: [null] }, { a: ["nested-combo"] }, { a: ["deepseek/cheap"] }, { a: ["codex/"] },
])("rejects invalid account customizations without changing the common config: %j", async accountOverrides => {
  const combo = await createCombo({ name: "safe", models: ["codex/common"] });
  expect((await update(combo.id, { models: ["codex/changed"], accountOverrides })).status).toBe(400);
  expect((await getComboById(combo.id)).models).toEqual(["codex/common"]);
});

it("includes account overrides in database backup and restore", async () => {
  const { exportDb, importDb } = await import("../../src/lib/db/index.js");
  const combo = await createCombo({ name: "backup", models: ["codex/common"] });
  await updateCombo(combo.id, { accountOverrides: { a: ["codex/cheap"] } });
  const backup = await exportDb();
  expect(backup.combos[0].accountOverrides).toEqual({ a: ["codex/cheap"] });
  await importDb(backup);
  expect((await getComboById(combo.id)).accountOverrides).toEqual({ a: ["codex/cheap"] });
  delete backup.combos[0].accountOverrides;
  await importDb(backup);
  expect((await getComboById(combo.id)).accountOverrides).toEqual({});
});
