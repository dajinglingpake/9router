import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let tempDir, db, readEstimate;
const originalDataDir = process.env.DATA_DIR;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-platform-estimate-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await (await import("@/lib/db/driver.js")).getAdapter();
  ({ GET: readEstimate } = await import("@/app/api/usage/platform-estimate/route.js"));

  for (const [id, key, name] of [
    ["a", "first-key", "同事 A"], ["b", "second-key", "同事 A"], ["c", "test-key", "备注 sk-test-synthetic"],
  ]) {
    db.run("INSERT INTO apiKeys(id, key, name, createdAt) VALUES (?, ?, ?, ?)", [id, key, name, "2026-11-01"]);
  }
  for (const [id, provider, active, plan] of [
    ["codex-plus", "codex", 1, "plus"], ["codex-pro", "codex", 1, "pro"],
    ["codex-disabled", "codex", 0, "plus"], ["kimi", "kimi", 1, ""],
  ]) {
    db.run("INSERT INTO providerConnections(id, provider, authType, isActive, data, createdAt, updatedAt) VALUES (?, ?, 'oauth', ?, ?, ?, ?)",
      [id, provider, active, JSON.stringify({ providerSpecificData: { chatgptPlanType: plan } }), "2026-11-01", "2026-11-01"]);
  }
  for (const row of [
    ["2026-10-31T15:59:59.999Z", "kimi", "first-key", "ok", 100],
    ["2026-10-31T16:00:00.000Z", "kimi", "first-key", "ok", 2],
    ["2026-11-03T10:00:00.000Z", "codex", "second-key", "success", 1],
    ["2026-11-20T10:00:00.000Z", "gemini", "first-key", "ok", 0],
    ["2026-11-20T11:00:00.000Z", "nvidia", "test-key", "ok", 0],
    ["2026-11-24T10:00:00.000Z", "kimi", "unknown-key", "ok", 3],
    ["2026-11-25T08:00:00.000Z", "deepseek", "first-key", "ok", 5],
    ["2026-11-28T12:00:00.000Z", "codex", "first-key", "error", 90],
    ["2026-11-30T15:59:59.999Z", "kimi", "first-key", "200", 4],
    ["2026-11-30T16:00:00.000Z", "codex", "first-key", "ok", 100],
  ]) {
    db.run("INSERT INTO usageHistory(timestamp, provider, apiKey, status, cost) VALUES (?, ?, ?, ?, ?)", row);
  }
});

afterAll(() => {
  db?.close?.();
  delete global._dbAdapter;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

const request = (query = "") => new NextRequest("http://router.test/api/usage/platform-estimate" + query);

describe("GET /api/usage/platform-estimate", () => {
  it("uses Beijing calendar boundaries, includes free APIs, and merges usage by display name", async () => {
    const response = await readEstimate(request("?month=2026-11"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.period).toEqual({ startDate: "2026-11-01", endDate: "2026-11-30", timeZone: "Asia/Shanghai" });
    expect(body.currency).toBe("USD");
    expect(body.totals).toEqual({ calls: 7, estimatedUsd: 15 });
    expect(body.accountSnapshot.activeByProvider).toEqual({ codex: { plus: 1, pro: 1 }, kimi: { any: 1 } });
    expect(body.byName).toEqual([
      { name: "同事 A", calls: 5, estimatedUsd: 12, callShare: 5 / 7, estimatedCostShare: 12 / 15, byProvider: expect.arrayContaining([
        { provider: "codex", calls: 1, estimatedUsd: 1 },
        { provider: "deepseek", calls: 1, estimatedUsd: 5 },
        { provider: "gemini", calls: 1, estimatedUsd: 0 },
        { provider: "kimi", calls: 2, estimatedUsd: 6 },
      ]) },
      { name: "AI 测试费用", calls: 2, estimatedUsd: 3, callShare: 2 / 7, estimatedCostShare: 3 / 15, byProvider: expect.arrayContaining([
        { provider: "nvidia", calls: 1, estimatedUsd: 0 },
        { provider: "kimi", calls: 1, estimatedUsd: 3 },
      ]) },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/first-key|second-key|sk-test-synthetic|unknown-key/);
  });

  it("applies provider exclusions and supports a day range", async () => {
    const filtered = await readEstimate(request("?month=2026-11&excludeProvider=deepseek&excludeProvider=nvidia"));
    expect((await filtered.json()).totals).toEqual({ calls: 5, estimatedUsd: 10 });
    const day = await readEstimate(request("?startDate=2026-11-01&endDate=2026-11-01"));
    expect((await day.json()).totals).toEqual({ calls: 1, estimatedUsd: 2 });
    const empty = await readEstimate(request("?month=2026-09"));
    expect((await empty.json()).byName).toEqual([]);
  });

  it("keeps call shares when all included usage is free", async () => {
    const response = await readEstimate(request("?month=2026-11&excludeProvider=kimi&excludeProvider=codex&excludeProvider=deepseek"));
    const body = await response.json();
    expect(body.totals).toEqual({ calls: 2, estimatedUsd: 0 });
    expect(body.byName.map(({ callShare, estimatedCostShare }) => [callShare, estimatedCostShare]))
      .toEqual([[0.5, 0], [0.5, 0]]);
  });

  it.each(["?month=2026-13", "?startDate=2026-02-30&endDate=2026-03-01",
    "?startDate=2026-11-02", "?month=2026-11&endDate=2026-11-30"])("rejects invalid dates %s", async query => {
    expect((await readEstimate(request(query))).status).toBe(400);
  });

  it("uses the dashboard API access gate", async () => {
    const { proxy } = await import("@/dashboardGuard");
    expect((await proxy(request("?month=2026-11"))).status).toBe(401);
  });
});
