import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
let db;
const originalDataDir = process.env.DATA_DIR;
const timestamp = "2026-11-05T12:00:00.000Z";
const date = new Date(timestamp);
const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-kimi-pricing-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await (await import("@/lib/db/driver.js")).getAdapter();
});

afterEach(() => {
  global._dbAdapter?.instance?.close?.();
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function insertUsage(model, { provider = "kimi", cost = 0 } = {}) {
  db.run(`INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, clientIp, promptTokens, completionTokens, cost, tokens)
    VALUES(?, ?, ?, 'account', 'test-key', '/v1/responses', '127.0.0.1', 1000, 100, ?, ?)`, [
    timestamp, provider, model, cost, JSON.stringify({
      prompt_tokens: 1000, cached_tokens: 600, completion_tokens: 100,
      reasoning_tokens: 80, completion_tokens_details: { reasoning_tokens: 80 },
    }),
  ]);
}

async function restart() {
  db.close();
  delete global._dbAdapter;
  vi.resetModules();
  db = await (await import("@/lib/db/driver.js")).getAdapter();
}

describe("Kimi Code missing-price repair", () => {
  it("repairs history and every daily cost bucket once without changing counters or other costs", async () => {
    insertUsage("k3.1-pro");
    insertUsage("k3.1-pro-highspeed");
    db.run("UPDATE usageHistory SET tokens = json_remove(tokens, '$.completion_tokens_details') WHERE model = 'k3.1-pro'");
    insertUsage("k3.1-pro", { cost: 0.5 });
    insertUsage("k3.1-pro", { provider: "openai" });
    const counter = () => ({ requests: 20, promptTokens: 20000, completionTokens: 2000, cachedTokens: 12000, cost: 0.5 });
    const day = { ...counter(), byProvider: { kimi: counter(), openai: counter() }, byAccount: { account: counter() },
      byModel: {}, byApiKey: {}, byClientIp: {}, byEndpoint: {} };
    for (const model of ["k3.1-pro", "k3.1-pro-highspeed"]) {
      day.byModel[`${model}|kimi`] = counter();
      day.byApiKey[`test-key|${model}|kimi`] = counter();
      day.byClientIp[`127.0.0.1|test-key|${model}|kimi`] = counter();
      day.byEndpoint[`/v1/responses|${model}|kimi`] = counter();
    }
    db.run("INSERT INTO usageDaily(dateKey, data) VALUES(?, ?)", [dateKey, JSON.stringify(day)]);
    db.run("UPDATE _meta SET value = '1' WHERE key = 'schemaVersion'");

    await restart();
    const rows = db.all("SELECT cost FROM usageHistory ORDER BY id");
    [0.00192, 0.00372, 0.5, 0].forEach((cost, i) => expect(rows[i].cost).toBeCloseTo(cost, 10));
    const repaired = JSON.parse(db.get("SELECT data FROM usageDaily WHERE dateKey = ?", [dateKey]).data);
    expect(repaired.cost).toBeCloseTo(0.50564, 10);
    expect(repaired.byProvider.kimi.cost).toBeCloseTo(0.50564, 10);
    expect(repaired.byAccount.account.cost).toBeCloseTo(0.50564, 10);
    expect(repaired.byProvider.openai).toEqual(day.byProvider.openai);
    for (const dimension of ["byModel", "byApiKey", "byClientIp", "byEndpoint"]) {
      for (const [key, value] of Object.entries(repaired[dimension])) {
        expect(value.cost).toBeCloseTo(0.5 + (key.includes("highspeed") ? 0.00372 : 0.00192), 10);
        expect({ ...value, cost: 0.5 }).toEqual(counter());
      }
    }
    expect({ ...repaired, cost: day.cost, byProvider: day.byProvider, byAccount: day.byAccount,
      byModel: day.byModel, byApiKey: day.byApiKey, byClientIp: day.byClientIp, byEndpoint: day.byEndpoint }).toEqual(day);

    // Replaying the repair must not add cost a second time, even if its version marker is reset.
    db.run("UPDATE _meta SET value = '1' WHERE key = 'schemaVersion'");
    await restart();
    expect(db.all("SELECT cost FROM usageHistory ORDER BY id")).toEqual(rows);
    expect(JSON.parse(db.get("SELECT data FROM usageDaily WHERE dateKey = ?", [dateKey]).data)).toEqual(repaired);
  });

  it("preserves user-defined zero prices and empty usage", async () => {
    insertUsage("k3.1-pro");
    insertUsage("k3.1-pro-highspeed");
    db.run("INSERT INTO kv(scope, key, value) VALUES('pricing', 'kimi', ?)", [JSON.stringify({
      "k3.1-pro": { input: 0, output: 0, cached: 0, reasoning: 0 },
    })]);
    db.run("UPDATE usageHistory SET tokens = '{}', promptTokens = 0, completionTokens = 0 WHERE model = 'k3.1-pro-highspeed'");
    db.run("UPDATE _meta SET value = '1' WHERE key = 'schemaVersion'");
    await restart();
    expect(db.all("SELECT cost FROM usageHistory")).toEqual([{ cost: 0 }, { cost: 0 }]);
  });

  it("persists a nonzero estimate for new requests", async () => {
    const { saveRequestUsage } = await import("@/lib/db/repos/usageRepo.js");
    await saveRequestUsage({ provider: "kimi", model: "k3.1-pro", timestamp,
      tokens: { prompt_tokens: 1000, completion_tokens: 100, cached_tokens: 600 } });
    expect(db.get("SELECT cost FROM usageHistory").cost).toBeCloseTo(0.00192, 10);
    expect(JSON.parse(db.get("SELECT data FROM usageDaily WHERE dateKey = ?", [dateKey]).data).cost).toBeCloseTo(0.00192, 10);
  });
});
