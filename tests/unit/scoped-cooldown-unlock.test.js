import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSqlJsAdapter } from "../../src/lib/db/adapters/sqljsAdapter.js";
import { TABLES, buildCreateTableSql } from "../../src/lib/db/schema.js";

const state = vi.hoisted(() => ({ db: null }));
vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: async () => state.db }));
vi.mock("@/lib/localDb", async () => import("../../src/lib/db/repos/connectionsRepo.js"));
import { createProviderConnection, getProviderConnectionById, updateProviderConnection } from "../../src/lib/db/repos/connectionsRepo.js";
import { POST } from "../../src/app/api/models/availability/route.js";

let tempDir;
beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-scoped-unlock-"));
  state.db = await createSqlJsAdapter(path.join(tempDir, "test.sqlite"));
  for (const [name, def] of Object.entries(TABLES)) state.db.exec(buildCreateTableSql(name, def));
});
afterEach(() => {
  state.db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
const future = () => new Date(Date.now() + 60000).toISOString();
const clear = model => POST(new Request("http://localhost/api/models/availability", {
  method: "POST", body: JSON.stringify({ action: "clearCooldown", provider: "codex", model }),
}));

it("clears only the requested model and preserves other quota locks and account cooldown", async () => {
  const until = future();
  const account = await createProviderConnection({ provider: "codex", authType: "apikey", name: "fixture" });
  await updateProviderConnection(account.id, { testStatus: "unavailable", errorCode: 503, lastError: "overloaded", modelLock_a: until, modelLock_b: until, modelLock___all: until });
  expect((await clear("a")).status).toBe(200);
  expect(await getProviderConnectionById(account.id)).toMatchObject({ modelLock_a: null, modelLock_b: until, modelLock___all: until, testStatus: "unavailable", errorCode: 503, lastError: "overloaded" });
  await clear("__all");
  expect(await getProviderConnectionById(account.id)).toMatchObject({ modelLock___all: null, modelLock_b: until, testStatus: "unavailable" });
  await clear("b");
  expect(await getProviderConnectionById(account.id)).toMatchObject({ testStatus: "active", lastError: null, errorCode: null, modelLock_b: null });
});

it("preserves a newly stored account lock when applying a stale runtime success patch", async () => {
  const account = await createProviderConnection({ provider: "codex", authType: "apikey", name: "fixture" });
  const successPatch = { testStatus: "active", lastError: null, errorCode: null, backoffLevel: 0 };
  const until = future();
  await updateProviderConnection(account.id, { testStatus: "unavailable", lastError: "overloaded", errorCode: 503, modelLock___all: until });
  await updateProviderConnection(account.id, successPatch, { resetHealthState: false });
  expect(await getProviderConnectionById(account.id)).toMatchObject({ testStatus: "unavailable", lastError: "overloaded", errorCode: 503, modelLock___all: until });
});

it("still clears all stale routing locks after an explicit successful account validation", async () => {
  const until = future();
  const account = await createProviderConnection({ provider: "codex", authType: "apikey", name: "fixture" });
  await updateProviderConnection(account.id, { testStatus: "unavailable", errorCode: 403, modelLock_a: until, modelLock___all: until });
  await updateProviderConnection(account.id, { testStatus: "active" });
  expect(await getProviderConnectionById(account.id)).toMatchObject({ testStatus: "active", errorCode: null, modelLock_a: null, modelLock___all: null });
});

it("does not clear an expired account lock that another request has since renewed", async () => {
  const account = await createProviderConnection({ provider: "codex", authType: "apikey", name: "fixture" });
  const expired = new Date(Date.now() - 1000).toISOString();
  await updateProviderConnection(account.id, { modelLock___all: expired, testStatus: "unavailable", errorCode: 503 });
  const until = future();
  await updateProviderConnection(account.id, { modelLock___all: until, lastError: "overloaded again" });
  await updateProviderConnection(account.id, { modelLock___all: null, testStatus: "active", errorCode: null }, {
    resetHealthState: false, expectedModelLocks: { modelLock___all: expired },
  });
  expect(await getProviderConnectionById(account.id)).toMatchObject({ modelLock___all: until, testStatus: "unavailable", errorCode: 503, lastError: "overloaded again" });
});
