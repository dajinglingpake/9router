import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSqlJsAdapter } from "../../src/lib/db/adapters/sqljsAdapter.js";
import { TABLES, buildCreateTableSql } from "../../src/lib/db/schema.js";

const state = vi.hoisted(() => ({ db: null }));
vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: async () => state.db }));
import { getRecentUsageOutcomes } from "../../src/lib/db/repos/usageRepo.js";

let tempDir;
beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-recent-usage-"));
  state.db = await createSqlJsAdapter(path.join(tempDir, "usage.sqlite"));
  state.db.exec(buildCreateTableSql("usageHistory", TABLES.usageHistory));
  for (const index of TABLES.usageHistory.indexes) state.db.exec(index);
  for (const [timestamp, status] of [
    ["2026-09-15T10:02:00.000Z", "FAILED 503"],
    ["2026-09-15T09:59:59.999Z", "200 OK"],
    ["2026-09-15T10:00:00.000Z", "200 OK"],
  ]) {
    state.db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, status, tokens, meta, apiKey) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      [timestamp, "codex", "sol", "account-a", status, "{}", "{}", "private-key"],
    );
  }
});
afterEach(() => {
  state.db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

it("returns only recent outcomes in time order, including the cutoff and failed requests", async () => {
  expect(await getRecentUsageOutcomes("2026-09-15T18:00:00+08:00")).toEqual([
    { timestamp: "2026-09-15T10:00:00.000Z", provider: "codex", model: "sol", connectionId: "account-a", status: "200 OK" },
    { timestamp: "2026-09-15T10:02:00.000Z", provider: "codex", model: "sol", connectionId: "account-a", status: "FAILED 503" },
  ]);
});

it("uses the timestamp range index instead of scanning historical requests", async () => {
  const query = vi.spyOn(state.db, "all");
  await getRecentUsageOutcomes("2026-09-15T10:00:00Z");
  const [sql, params] = query.mock.calls[0];
  query.mockRestore();
  const plan = state.db.all(`EXPLAIN QUERY PLAN ${sql}`, params).map(row => row.detail).join("\n");
  expect(plan).toMatch(/SEARCH usageHistory USING INDEX idx_uh_ts/);
  expect(plan).not.toMatch(/SCAN usageHistory|TEMP B-TREE/);
});
