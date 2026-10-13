import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/oauth/providers", () => ({ backfillCodexEmails: vi.fn() }));

const originalDataDir = process.env.DATA_DIR;
let tempDir, db, account, listeners;

beforeEach(async () => {
  listeners = Object.fromEntries(["beforeExit", "exit", "SIGINT", "SIGTERM"].map(event => [event, new Set(process.rawListeners(event))]));
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-account-marker-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  const key = await db.createApiKey("owner", "test-machine");
  account = await db.createProviderConnection({
    provider: "codex", authType: "oauth", name: "Account", email: "owner@example.com",
    isActive: false, priority: 5, exclusiveApiKeyIds: [key.id],
    accessToken: "saved-access", refreshToken: "saved-refresh", idToken: "saved-id",
    minRequestIntervalMs: 1000, accountCooldownMinMs: 30000,
    providerSpecificData: { chatgptAccountId: "workspace-1", proxyPoolId: "saved-proxy" },
  });
  await db.updateProviderConnection(account.id, {
    testStatus: "unavailable", errorCode: 401, lastError: "invalid credentials",
    modelLock___all: "2099-01-01T00:00:00.000Z", maxConcurrency: 2,
  });
  account = await db.getProviderConnectionById(account.id);
});

afterEach(() => {
  vi.useRealTimers();
  global._dbAdapter?.instance?.close?.();
  delete global._dbAdapter;
  for (const [event, original] of Object.entries(listeners)) {
    for (const listener of process.rawListeners(event)) if (!original.has(listener)) process.removeListener(event, listener);
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function update(patch, id = account.id) {
  const { PUT } = await import("@/app/api/providers/[id]/route.js");
  return PUT(new Request(`http://localhost/api/providers/${id}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
  }), { params: Promise.resolve({ id }) });
}

async function reopen() {
  global._dbAdapter.instance.close();
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
}

function withoutMarkerAndUpdateTime(connection) {
  const { isDegraded, degradedMarkedAt, updatedAt, ...rest } = connection;
  return rest;
}

describe("manual account degradation marker", () => {
  it("persists marking and clearing a disabled account without changing its settings or credentials", async () => {
    for (const isDegraded of [true, false]) {
      const response = await update({ isDegraded });
      expect(response.status).toBe(200);
      expect((await response.json()).connection.isDegraded).toBe(isDegraded);
      await reopen();
      const saved = await db.getProviderConnectionById(account.id);
      expect(saved.isDegraded).toBe(isDegraded);
      expect(saved.degradedMarkedAt).toEqual(isDegraded ? expect.any(String) : null);
      expect(withoutMarkerAndUpdateTime(saved)).toEqual(withoutMarkerAndUpdateTime(account));
    }
  });

  it("returns the saved marker on quota refresh and single-account reads without exposing credentials", async () => {
    await update({ isDegraded: true });
    const quotaApi = await import("@/app/api/providers/client/route.js");
    const accountApi = await import("@/app/api/providers/[id]/route.js");
    const quotaResponse = await quotaApi.GET(new Request("http://localhost/api/providers/client?provider=codex&accountStatus=inactive"));
    const accountResponse = await accountApi.GET(new Request(`http://localhost/api/providers/${account.id}`), { params: Promise.resolve({ id: account.id }) });
    expect(quotaResponse.status).toBe(200);
    expect(accountResponse.status).toBe(200);
    const quotaData = await quotaResponse.json();
    const accountData = await accountResponse.json();
    expect(quotaData.connections[0]).toMatchObject({ id: account.id, isDegraded: true, degradedMarkedAt: expect.any(String), isActive: false, exclusiveApiKeyNames: ["owner"] });
    expect(accountData.connection.isDegraded).toBe(true);
    expect(accountData.connection.degradedMarkedAt).toBe(quotaData.connections[0].degradedMarkedAt);
    for (const secret of ["saved-access", "saved-refresh", "saved-id"]) {
      expect(JSON.stringify(quotaData)).not.toContain(secret);
      expect(JSON.stringify(accountData)).not.toContain(secret);
    }
    await update({ isDegraded: false });
    const cleared = await (await quotaApi.GET(new Request("http://localhost/api/providers/client"))).json();
    expect(cleared.connections[0].isDegraded).toBe(false);
    expect(cleared.connections[0].degradedMarkedAt).toBeNull();
  });

  it("keeps the marker through ordinary edits, activation and credential refresh", async () => {
    await update({ isDegraded: true });
    const { degradedMarkedAt } = await db.getProviderConnectionById(account.id);
    expect((await update({ name: "Renamed", isActive: true })).status).toBe(200);
    await db.updateProviderConnection(account.id, { accessToken: "refreshed-access", testStatus: "active" });
    expect(await db.getProviderConnectionById(account.id)).toMatchObject({ isDegraded: true, degradedMarkedAt, isActive: true, name: "Renamed", accessToken: "refreshed-access" });
  });

  it("uses server time, preserves repeated marks and records a new time after clearing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const firstTime = "2026-10-13T07:00:00.000Z";
    vi.setSystemTime(new Date(firstTime));
    expect((await update({ isDegraded: true, degradedMarkedAt: "2000-01-01T00:00:00.000Z" })).status).toBe(200);
    expect((await db.getProviderConnectionById(account.id)).degradedMarkedAt).toBe(firstTime);

    const nextTime = "2026-10-13T08:00:00.000Z";
    vi.setSystemTime(new Date(nextTime));
    await update({ isDegraded: true });
    expect((await db.getProviderConnectionById(account.id)).degradedMarkedAt).toBe(firstTime);
    await update({ isDegraded: false });
    expect((await db.getProviderConnectionById(account.id)).degradedMarkedAt).toBeNull();
    await update({ isDegraded: true });
    await reopen();
    expect((await db.getProviderConnectionById(account.id)).degradedMarkedAt).toBe(nextTime);
  });

  it("does not invent a timestamp for an existing marker during unrelated edits", async () => {
    await db.updateProviderConnection(account.id, { isDegraded: true });
    await update({ name: "Old marked account" });
    const saved = await db.getProviderConnectionById(account.id);
    expect(saved.isDegraded).toBe(true);
    expect(saved.degradedMarkedAt).toBeUndefined();
  });

  it.each([null, "true", "false", 1, 0, {}, []])("rejects a non-boolean marker (%j) without applying other edits", async isDegraded => {
    expect((await update({ isDegraded, name: "Should not be saved" })).status).toBe(400);
    expect(await db.getProviderConnectionById(account.id)).toEqual(account);
  });

  it("preserves a marker supplied on creation and leaves other accounts unmarked", async () => {
    const degradedMarkedAt = "2026-10-13T07:00:00.000Z";
    const marked = await db.createProviderConnection({ provider: "codex", authType: "oauth", name: "Marked", isDegraded: true, degradedMarkedAt });
    await reopen();
    expect(await db.getProviderConnectionById(marked.id)).toMatchObject({ isDegraded: true, degradedMarkedAt });
    expect((await db.getProviderConnectionById(account.id)).isDegraded).toBeUndefined();
  });

  it("returns 404 for an unknown account", async () => {
    expect((await update({ isDegraded: true }, "missing-account")).status).toBe(404);
    expect(await db.getProviderConnections()).toHaveLength(1);
  });
});
