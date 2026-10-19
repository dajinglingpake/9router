import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/oauth/providers", () => ({ backfillCodexEmails: vi.fn() }));
const now = Date.parse("2026-10-16T04:00:00.000Z"), oneHour = 3600000;
const originalDataDir = process.env.DATA_DIR;
let tempDir, db, adapter, getUsers, shared, bound, alice, bob, listeners;

beforeEach(async () => {
  listeners = Object.fromEntries(["beforeExit", "exit", "SIGINT", "SIGTERM"].map(event => [event, new Set(process.rawListeners(event))]));
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-recent-users-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  getUsers = (await import("@/lib/recentAccountApiKeyUsers.js")).getRecentAccountApiKeyUsers;
  alice = await db.createApiKey("Alice", "test-machine");
  bob = await db.createApiKey("Bob", "test-machine");
  shared = await db.createProviderConnection({ provider: "codex", authType: "oauth", name: "Shared", priority: 1, isActive: false, accessToken: "private-access", refreshToken: "private-refresh" });
  bound = await db.createProviderConnection({ provider: "codex", authType: "oauth", name: "Dedicated", priority: 2, exclusiveApiKeyIds: [alice.id] });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await global._requestErrorWrites?.pending;
  global._dbAdapter?.instance?.close?.();
  delete global._dbAdapter;
  for (const [event, original] of Object.entries(listeners)) for (const listener of process.rawListeners(event)) if (!original.has(listener)) process.removeListener(event, listener);
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = originalDataDir;
});

function usage(key, timestamp, account = shared) {
  adapter.run("INSERT INTO usageHistory(timestamp, provider, connectionId, apiKey, status) VALUES(?, ?, ?, ?, ?)", [new Date(timestamp).toISOString(), "codex", account.id, key, "ok"]);
}
function error(key, timestamp, account = shared, data = {}) {
  adapter.run("INSERT INTO requestErrors(timestamp, connectionId, category, data) VALUES(?, ?, ?, ?)", [timestamp, account.id, "upstream", JSON.stringify({ apiKeyId: key?.id, apiKeyName: key?.name, ...data })]);
}

describe("recent callers of shared accounts", () => {
  it("combines successful and failed attempts, deduplicates callers and orders by last use", async () => {
    usage(alice.key, now - 600000);
    usage(alice.key, now - 500000);
    error(alice, now - 1000);
    error(bob, now - 2000);
    error(bob, now - 3000);
    usage(bob.key, now - 500, bound);
    const users = await getUsers([shared, bound], now);
    expect(users.get(shared.id)).toEqual([
      { id: alice.id, name: "Alice", lastUsedAt: new Date(now - 1000).toISOString() },
      { id: bob.id, name: "Bob", lastUsedAt: new Date(now - 2000).toISOString() },
    ]);
    expect(users.get(bound.id)).toEqual([]);
    expect((await db.getProviderConnectionById(shared.id)).isActive).toBe(false);
  });

  it("uses exactly the last hour, includes the start and excludes older, current or future timestamps", async () => {
    usage(alice.key, now - oneHour);
    error(alice, now - oneHour - 1);
    usage(bob.key, now - oneHour - 1);
    error(bob, now - oneHour - 1);
    usage(bob.key, now - 2 * oneHour);
    usage(bob.key, now);
    error(bob, now);
    error(bob, now + 1000);
    expect((await getUsers([shared], now)).get(shared.id)).toEqual([{ id: alice.id, name: "Alice", lastUsedAt: new Date(now - oneHour).toISOString() }]);
    expect((await getUsers([shared], now + oneHour + 1001)).get(shared.id)).toEqual([]);
  });

  it("uses current names and disabled status while keeping equal-name keys distinct", async () => {
    await db.updateApiKey(alice.id, { name: "Same name", isActive: false });
    await db.updateApiKey(bob.id, { name: "Same name" });
    usage(alice.key, now - 1000);
    error(alice, now - 500, shared, { apiKeyName: "Outdated name" });
    error(bob, now - 2000);
    expect((await getUsers([shared], now)).get(shared.id)).toEqual([
      { id: alice.id, name: "Same name（已停用）", lastUsedAt: new Date(now - 500).toISOString() },
      { id: bob.id, name: "Same name", lastUsedAt: new Date(now - 2000).toISOString() },
    ]);
  });

  it("handles deleted and unattributed keys without returning raw keys or malformed log data", async () => {
    const deletedKey = "private-deleted-key-value", deletedId = "private-deleted-record-identity";
    usage(deletedKey, now - 1000);
    error({ id: deletedId, name: "Former caller" }, now - 2000);
    usage(null, now - 3000);
    usage("", now - 4000);
    error(null, now - 5000, shared, { apiKeyName: "Do not infer identity from a name" });
    adapter.run("INSERT INTO requestErrors(timestamp, connectionId, category, data) VALUES(?, ?, ?, ?)", [now - 6000, shared.id, "upstream", "invalid JSON with private data"]);
    const users = (await getUsers([shared], now)).get(shared.id);
    expect(users).toHaveLength(3);
    expect(users[0]).toMatchObject({ id: expect.stringMatching(/^deleted-[a-f0-9]{16}$/), name: expect.stringMatching(/^已删除 Key/) });
    expect(users[1]).toMatchObject({ id: expect.stringMatching(/^deleted-[a-f0-9]{16}$/), name: "Former caller（已删除）" });
    expect(users[2]).toMatchObject({ id: "unattributed", name: "未记录 API Key" });
    for (const secret of [deletedKey, deletedId, "private data", "Do not infer identity"]) expect(JSON.stringify(users)).not.toContain(secret);
  });

  it("returns empty lists and performs no log reads for empty or exclusively bound pages", async () => {
    const read = vi.spyOn(adapter, "all");
    expect(await getUsers([], now)).toEqual(new Map());
    expect((await getUsers([bound], now)).get(bound.id)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it("shows history after unbinding without changing the saved binding", async () => {
    usage(bob.key, now - 1000, bound);
    expect((await getUsers([bound], now)).get(bound.id)).toEqual([]);
    expect((await getUsers([{ ...bound, exclusiveApiKeyIds: [] }], now)).get(bound.id)).toMatchObject([{ id: bob.id, name: "Bob" }]);
    expect((await db.getProviderConnectionById(bound.id)).exclusiveApiKeyIds).toEqual([alice.id]);
  });

  it("exposes safe recent callers in quota and provider lists while preserving account configuration", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    usage(alice.key, now - 1000);
    error(bob, now - 2000);
    const pastCaller = await db.createApiKey("Past caller", "test-machine");
    usage(pastCaller.key, now - 2 * oneHour);
    error(pastCaller, now - 2 * oneHour);
    const before = await db.getProviderConnectionById(shared.id);
    const quota = await import("@/app/api/providers/client/route.js");
    const providers = await import("@/app/api/providers/route.js");
    for (const response of [await quota.GET(new Request("http://localhost/api/providers/client")), await providers.GET()]) {
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const data = await response.json();
      expect(data.connections.find(c => c.id === shared.id).recentApiKeyUsers.map(user => user.name)).toEqual(["Alice", "Bob"]);
      expect(data.connections.find(c => c.id === bound.id)).toMatchObject({ exclusiveApiKeyIds: [alice.id], exclusiveApiKeyNames: ["Alice"], recentApiKeyUsers: [] });
      for (const secret of [alice.key, bob.key, "private-access", "private-refresh"]) expect(JSON.stringify(data)).not.toContain(secret);
    }
    expect(await db.getProviderConnectionById(shared.id)).toEqual(before);
  });

  it("keeps recent callers attached to the correct account across paging and account-status filters", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const second = await db.createProviderConnection({ provider: "codex", authType: "oauth", name: "Other shared", priority: 3 });
    usage(alice.key, now - 1000);
    error(bob, now - 2000, second);
    const quota = await import("@/app/api/providers/client/route.js");
    const response = await quota.GET(new Request("http://localhost/api/providers/client?accountStatus=active&pageSize=1&page=2"));
    const data = await response.json();
    expect(data.connections).toHaveLength(1);
    expect(data.connections[0].id).toBe(second.id);
    expect(data.connections[0].recentApiKeyUsers).toMatchObject([{ id: bob.id, name: "Bob" }]);
  });
});
