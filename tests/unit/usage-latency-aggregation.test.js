import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let adapter;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-latency-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  const { getAdapter } = await import("@/lib/db/driver.js");
  adapter = await getAdapter();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

it("groups only valid latency samples into bounded model and time buckets", async () => {
  const start = Date.parse("2026-09-20T00:00:00.000Z");
  const hour = 60 * 60 * 1000;
  const insert = (offset, model, meta) => adapter.run(
    "INSERT INTO usageHistory(timestamp, model, meta) VALUES(?, ?, ?)",
    [new Date(start + offset).toISOString(), model, meta],
  );

  insert(0, "sol", JSON.stringify({ latency: { total: 100 } }));
  insert(hour - 1, "sol", JSON.stringify({ latency: { total: 300 } }));
  insert(hour, "sol", JSON.stringify({ latency: { total: 500 } }));
  insert(hour + 1, "luna", JSON.stringify({ latency: { total: 50 } }));
  insert(hour + 2, "luna", "{invalid-json");
  insert(hour + 3, "luna", JSON.stringify({ latency: { total: -1 } }));
  insert(hour + 4, "idle", JSON.stringify({ latency: null }));
  insert(2 * hour, "outside", JSON.stringify({ latency: { total: 10 } }));
  insert(0, null, JSON.stringify({ latency: { total: 10 } }));

  const rows = await db.getUsageLatencyByBucket(start, hour, 2);
  expect(rows).toEqual(expect.arrayContaining([
    { bucket: 0, model: "sol", totalLatency: 400, requests: 2 },
    { bucket: 1, model: "sol", totalLatency: 500, requests: 1 },
    { bucket: 1, model: "luna", totalLatency: 50, requests: 1 },
    { bucket: 1, model: "idle", totalLatency: null, requests: 0 },
  ]));
  expect(rows).toHaveLength(4);
});
