import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/alerts/wecom.js", () => ({ notifyRequestError: vi.fn().mockResolvedValue(undefined) }));

const originalDataDir = process.env.DATA_DIR;
let tempDir, db, errors, warnings, listeners;

beforeEach(async () => {
  listeners = Object.fromEntries(["beforeExit", "exit", "SIGINT", "SIGTERM"].map(event => [event, new Set(process.rawListeners(event))]));
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-overload-warning-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  errors = await import("@/lib/db/repos/requestErrorsRepo.js");
  warnings = await import("@/lib/db/repos/accountOverloadWarningsRepo.js");
});

afterEach(async () => {
  await global._requestErrorWrites?.pending;
  global._dbAdapter?.instance?.close?.();
  delete global._dbAdapter;
  for (const [event, original] of Object.entries(listeners)) {
    for (const listener of process.rawListeners(event)) {
      if (!original.has(listener)) process.removeListener(event, listener);
    }
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function account(name = "test") {
  return db.createProviderConnection({ provider: "codex", authType: "oauth", name, accessToken: "private-token", refreshToken: "private-refresh", isActive: true });
}

function log(connectionId, extra = {}) {
  return errors.saveRequestError({ connectionId, provider: "codex", model: "test-model", status: "FAILED 503", source: "upstream", message: "Our servers are currently overloaded", ...extra });
}

async function dismissRoute(connectionId, eventId) {
  const { DELETE } = await import("@/app/api/providers/[id]/overload-warning/route.js");
  return DELETE(new Request("http://localhost/api/providers/test/overload-warning", {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ eventId }),
  }), { params: Promise.resolve({ id: connectionId }) });
}

describe("account overload history warnings", () => {
  it("keeps recovered upstream 503 history visible after account health recovers", async () => {
    const a = await account();
    const id = await log(a.id, { timestamp: 1000, transient: true });
    await errors.markRequestErrorsRecovered([Promise.resolve(id)]);
    await db.updateProviderConnection(a.id, { testStatus: "active", lastError: null });
    expect((await warnings.getAccountOverloadWarnings())[a.id]).toEqual({ eventId: expect.any(String), lastAt: 1000, count: 1 });
    expect((await errors.getRequestErrors()).items[0].recovered).toBe(true);
  });

  it("excludes local queue errors, other status codes and records without accounts", async () => {
    const a = await account();
    await log(a.id, { source: "router", message: "Concurrency queue wait timed out" });
    await log(a.id, { status: "FAILED 502" });
    await log(a.id, { status: "FAILED 429" });
    await log(null);
    expect(await warnings.getAccountOverloadWarnings()).toEqual({});
  });

  it("clears only the badge and persists dismissal across a database restart", async () => {
    const a = await account();
    await db.updateProviderConnection(a.id, { testStatus: "unavailable", errorCode: 503, modelLock___all: new Date(Date.now() + 60_000).toISOString() });
    const before = await db.getProviderConnectionById(a.id);
    await log(a.id);
    const warning = (await warnings.getAccountOverloadWarnings())[a.id];
    expect((await dismissRoute(a.id, warning.eventId)).status).toBe(200);
    expect(await warnings.getAccountOverloadWarnings()).toEqual({});
    expect((await errors.getRequestErrors()).total).toBe(1);
    expect(await db.getProviderConnectionById(a.id)).toEqual(before);

    global._dbAdapter.instance.close();
    delete global._dbAdapter;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    await db.initDb();
    errors = await import("@/lib/db/repos/requestErrorsRepo.js");
    warnings = await import("@/lib/db/repos/accountOverloadWarningsRepo.js");
    expect(await warnings.getAccountOverloadWarnings()).toEqual({});
    expect((await errors.getRequestErrors()).total).toBe(1);
  });

  it("shows a new overload after dismissal even if its timestamp is older", async () => {
    const a = await account();
    await log(a.id, { timestamp: 2000 });
    const first = (await warnings.getAccountOverloadWarnings(a.id))[a.id];
    await warnings.dismissAccountOverloadWarning(a.id, first.eventId);
    await log(a.id, { timestamp: 1000 });
    const next = (await warnings.getAccountOverloadWarnings(a.id))[a.id];
    expect(next.lastAt).toBe(1000);
    expect(next.eventId).not.toBe(first.eventId);
  });

  it("preserves a concurrent newer error when clearing the displayed warning", async () => {
    const a = await account();
    await log(a.id);
    const first = (await warnings.getAccountOverloadWarnings(a.id))[a.id];
    await log(a.id);
    const next = (await warnings.getAccountOverloadWarnings(a.id))[a.id];
    expect((await (await dismissRoute(a.id, first.eventId)).json()).overloadWarning).toEqual(next);
  });

  it("does not undo a newer dismissal and keeps accounts isolated", async () => {
    const a = await account("a"), b = await account("b");
    await log(a.id);
    const first = (await warnings.getAccountOverloadWarnings(a.id))[a.id];
    await log(b.id);
    await log(a.id);
    const next = (await warnings.getAccountOverloadWarnings(a.id))[a.id];
    await warnings.dismissAccountOverloadWarning(a.id, next.eventId);
    await warnings.dismissAccountOverloadWarning(a.id, first.eventId);
    expect(await warnings.getAccountOverloadWarnings(a.id)).toEqual({});
    expect(Object.keys(await warnings.getAccountOverloadWarnings())).toEqual([b.id]);
  });

  it("keeps the warning independently of log cleanup", async () => {
    const a = await account();
    const id = await log(a.id);
    await errors.clearRequestErrors({ beforeId: id });
    expect((await warnings.getAccountOverloadWarnings(a.id))[a.id]).toBeDefined();
    expect((await errors.getRequestErrors()).total).toBe(0);
  });

  it("restores pre-feature account failures and retains them through recovery", async () => {
    const a = await account();
    const adapter = global._dbAdapter.instance;
    adapter.run(`UPDATE providerConnections SET data = ? WHERE id = ?`, [JSON.stringify({ errorCode: 503, lastErrorAt: "2026-10-10T01:00:00Z" }), a.id]);
    const warning = (await warnings.getAccountOverloadWarnings(a.id))[a.id];
    expect(warning.lastAt).toBe(new Date("2026-10-10T01:00:00Z").getTime());
    await db.updateProviderConnection(a.id, { testStatus: "active" });
    expect((await warnings.getAccountOverloadWarnings(a.id))[a.id]).toEqual(warning);
    expect((await errors.getRequestErrors()).total).toBe(0);
  });

  it("preserves legacy history even when the first new-version operation is recovery", async () => {
    const a = await account();
    global._dbAdapter.instance.run(`UPDATE providerConnections SET data = ? WHERE id = ?`, [JSON.stringify({ errorCode: 503, lastErrorAt: "2026-10-10T01:00:00Z" }), a.id]);
    await db.updateProviderConnection(a.id, { testStatus: "active" });
    expect((await warnings.getAccountOverloadWarnings(a.id))[a.id].lastAt).toBe(new Date("2026-10-10T01:00:00Z").getTime());
  });

  it("backfills retained logs from before the feature was added", async () => {
    const a = await account();
    await log(a.id, { timestamp: 2000, recovered: true });
    global._dbAdapter.instance.run(`DELETE FROM kv WHERE scope = 'accountOverloadHistory'`);
    expect((await warnings.getAccountOverloadWarnings(a.id))[a.id].lastAt).toBe(2000);
  });

  it("records new health-level overloads without requiring an error-log entry", async () => {
    const a = await account();
    await db.updateProviderConnection(a.id, { errorCode: 503, lastErrorAt: "2026-10-10T01:00:00Z" });
    const first = (await warnings.getAccountOverloadWarnings(a.id))[a.id];
    await warnings.dismissAccountOverloadWarning(a.id, first.eventId);
    await db.updateProviderConnection(a.id, { testStatus: "active" });
    expect(await warnings.getAccountOverloadWarnings(a.id)).toEqual({});
    await db.updateProviderConnection(a.id, { errorCode: 503, lastErrorAt: "2026-10-10T01:01:00Z" });
    expect((await warnings.getAccountOverloadWarnings(a.id))[a.id].eventId).not.toBe(first.eventId);
  });

  it("returns warning metadata from list and detail without exposing tokens", async () => {
    const a = await account();
    await log(a.id);
    const list = await import("@/app/api/providers/route.js");
    const detail = await import("@/app/api/providers/[id]/route.js");
    const responses = [
      (await (await list.GET()).json()).connections[0],
      (await (await detail.GET(null, { params: Promise.resolve({ id: a.id }) })).json()).connection,
    ];
    for (const connection of responses) {
      expect(connection.overloadWarning.eventId).toEqual(expect.any(String));
      expect(connection.accessToken).toBeUndefined();
      expect(connection.refreshToken).toBeUndefined();
    }
    expect((await (await dismissRoute(a.id, responses[0].overloadWarning.eventId)).json()).overloadWarning).toBeNull();
  });

  it.each([undefined, null, 0, {}, "1", "invalid"])("rejects invalid warning event %s", async eventId => {
    const a = await account();
    await log(a.id);
    expect((await dismissRoute(a.id, eventId)).status).toBe(400);
    expect((await errors.getRequestErrors()).total).toBe(1);
    expect((await warnings.getAccountOverloadWarnings())[a.id]).toBeDefined();
  });

  it("does not clear a warning using an unknown event identifier", async () => {
    const a = await account();
    await log(a.id);
    const warning = (await warnings.getAccountOverloadWarnings(a.id))[a.id];
    const response = await dismissRoute(a.id, "00000000-0000-0000-0000-000000000000");
    expect((await response.json()).overloadWarning).toEqual(warning);
  });

  it("rejects clearing an unknown account", async () => {
    expect((await dismissRoute("missing-account", "00000000-0000-0000-0000-000000000000")).status).toBe(404);
  });

  it.each([false, true])("counts a failed attempt once with either health/log write order (health first: %s)", async healthFirst => {
    const a = await account();
    const health = () => db.updateProviderConnection(a.id, { errorCode: 503, lastErrorAt: "2026-10-10T01:00:00Z" });
    for (let i = 0; i < 3; i++) {
      if (healthFirst) await health();
      await log(a.id, { requestId: `attempt-${i}`, transient: true });
      if (!healthFirst) await health();
      await log(a.id, { requestId: `attempt-${i}`, transient: false });
    }
    expect((await warnings.getAccountOverloadWarnings(a.id))[a.id].count).toBe(3);
    await errors.clearRequestErrors({ beforeId: Number.MAX_SAFE_INTEGER });
    expect((await warnings.getAccountOverloadWarnings(a.id))[a.id].count).toBe(3);
  });

  it("resets counts and limits details to failures after the last clear", async () => {
    const a = await account(), b = await account("other");
    await log(a.id);
    await log(a.id);
    const first = (await warnings.getAccountOverloadWarnings(a.id))[a.id];
    expect(first.count).toBe(2);
    await warnings.dismissAccountOverloadWarning(a.id, first.eventId);
    await log(a.id, { upstreamStatus: 200, recovered: true });
    await log(b.id);
    const { GET } = await import("@/app/api/providers/[id]/overload-warning/route.js");
    const details = await (await GET(null, { params: Promise.resolve({ id: a.id }) })).json();
    expect(details.overloadWarning.count).toBe(1);
    expect(details.items).toHaveLength(1);
    expect(details.items[0]).toMatchObject({ model: "test-model", upstreamStatus: 200, recovered: true, statusCode: 503 });
    expect(JSON.stringify(details)).not.toMatch(/private-token|private-refresh|accessToken|refreshToken/);
    expect((await GET(null, { params: Promise.resolve({ id: "missing" }) })).status).toBe(404);
  });

  it("upgrades legacy counters and UUID-only dismissals without resurrecting cleared errors", async () => {
    const a = await account();
    await log(a.id);
    await log(a.id);
    const old = (await warnings.getAccountOverloadWarnings(a.id))[a.id];
    delete old.count;
    const adapter = global._dbAdapter.instance;
    adapter.run(`UPDATE kv SET value = ? WHERE scope = 'accountOverloadHistory' AND key = ?`, [JSON.stringify(old), a.id]);
    expect((await warnings.getAccountOverloadWarnings(a.id))[a.id].count).toBe(2);
    adapter.run(`UPDATE kv SET value = ? WHERE scope = 'accountOverloadHistory' AND key = ?`, [JSON.stringify(old), a.id]);
    adapter.run(`INSERT INTO kv(scope, key, value) VALUES('accountOverloadDismissed', ?, ?)`, [a.id, old.eventId]);
    await log(a.id, { model: "new-model" });
    const details = await warnings.getAccountOverloadDetails(a.id);
    expect(details.overloadWarning.count).toBe(1);
    expect(details.items.map(item => item.model)).toEqual(["new-model"]);
  });

  it("paginates details without reducing the persistent count", async () => {
    const a = await account();
    for (let i = 0; i < 55; i++) await log(a.id);
    const details = await warnings.getAccountOverloadDetails(a.id);
    expect(details.overloadWarning.count).toBe(55);
    expect(details.items).toHaveLength(50);
    expect(details.hasMore).toBe(true);
  });

  it("includes safe overload counts in the quota tracker account response", async () => {
    const a = await account();
    await log(a.id);
    const { GET } = await import("@/app/api/providers/client/route.js");
    const response = await GET(new Request("http://localhost/api/providers/client?provider=codex"));
    expect(response.status).toBe(200);
    const connection = (await response.json()).connections[0];
    expect(connection.overloadWarning.count).toBe(1);
    expect(connection.accessToken).toBeUndefined();
    expect(connection.refreshToken).toBeUndefined();
  });
});
