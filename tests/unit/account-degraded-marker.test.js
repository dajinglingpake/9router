import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_QUALITY_MAX_LENGTH, getAccountQualityStatus, getAccountQualityLabel, getAccountQualityMarkedAt } from "@/shared/utils/accountQuality.js";

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
  const { isDegraded, degradedMarkedAt, qualityStatus, qualityLabel, qualityMarkedAt, updatedAt, ...rest } = connection;
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
    const marked = await db.createProviderConnection({ provider: "codex", authType: "oauth", name: "Marked", isDegraded: true, degradedMarkedAt, qualityStatus: "degraded", qualityMarkedAt: degradedMarkedAt });
    await reopen();
    expect(await db.getProviderConnectionById(marked.id)).toMatchObject({ isDegraded: true, degradedMarkedAt, qualityStatus: "degraded", qualityMarkedAt: degradedMarkedAt });
    expect((await db.getProviderConnectionById(account.id)).isDegraded).toBeUndefined();
  });

  it("returns 404 for an unknown account", async () => {
    expect((await update({ isDegraded: true }, "missing-account")).status).toBe(404);
    expect(await db.getProviderConnections()).toHaveLength(1);
  });

  it.each(["normal", "slow", "degraded"])("persists %s on disabled accounts and returns it on quota refresh", async qualityStatus => {
    const response = await update({ qualityStatus, qualityMarkedAt: "2000-01-01T00:00:00.000Z" });
    expect(response.status).toBe(200);
    const returned = (await response.json()).connection;
    expect(returned.qualityStatus).toBe(qualityStatus);
    expect(returned.qualityMarkedAt).toEqual(expect.any(String));
    expect(returned.qualityMarkedAt).not.toBe("2000-01-01T00:00:00.000Z");
    await reopen();
    const saved = await db.getProviderConnectionById(account.id);
    expect(saved).toMatchObject({ qualityStatus, qualityMarkedAt: returned.qualityMarkedAt, isActive: false, isDegraded: qualityStatus === "degraded" });
    expect(saved.degradedMarkedAt).toBe(qualityStatus === "degraded" ? returned.qualityMarkedAt : null);
    expect(withoutMarkerAndUpdateTime(saved)).toEqual(withoutMarkerAndUpdateTime(account));
    const { GET } = await import("@/app/api/providers/client/route.js");
    const data = await (await GET(new Request("http://localhost/api/providers/client?accountStatus=inactive"))).json();
    expect(data.connections[0]).toMatchObject({ qualityStatus, qualityMarkedAt: returned.qualityMarkedAt });
    for (const secret of ["saved-access", "saved-refresh", "saved-id"]) expect(JSON.stringify(data)).not.toContain(secret);
  });

  it("timestamps state changes, preserves repeat selections and clears all marker fields", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let previousTime = null;
    for (const [index, qualityStatus] of ["normal", "slow", "degraded", null, "normal"].entries()) {
      const now = new Date(Date.UTC(2026, 9, 13, 7 + index)).toISOString();
      vi.setSystemTime(new Date(now));
      expect((await update({ qualityStatus })).status).toBe(200);
      const saved = await db.getProviderConnectionById(account.id);
      expect(saved.qualityMarkedAt).toBe(qualityStatus ? now : null);
      expect(saved.qualityStatus).toBe(qualityStatus);
      if (qualityStatus) {
        expect(saved.qualityMarkedAt).not.toBe(previousTime);
        previousTime = saved.qualityMarkedAt;
        vi.setSystemTime(new Date(Date.parse(now) + 10000));
        await update({ qualityStatus, name: "Renamed account" });
        expect((await db.getProviderConnectionById(account.id)).qualityMarkedAt).toBe(now);
      } else {
        expect(saved).toMatchObject({ isDegraded: false, degradedMarkedAt: null });
      }
    }
  });

  it("keeps the original timestamp when an existing degradation marker is first selected in the new UI", async () => {
    const degradedMarkedAt = "2026-10-13T07:00:00.000Z";
    await db.updateProviderConnection(account.id, { isDegraded: true, degradedMarkedAt });
    const legacy = await db.getProviderConnectionById(account.id);
    expect(getAccountQualityStatus(legacy)).toBe("degraded");
    expect(getAccountQualityMarkedAt(legacy)).toBe(degradedMarkedAt);
    await update({ qualityStatus: "degraded" });
    expect(await db.getProviderConnectionById(account.id)).toMatchObject({ qualityStatus: "degraded", qualityMarkedAt: degradedMarkedAt });
    await update({ isDegraded: false });
    expect(await db.getProviderConnectionById(account.id)).toMatchObject({ qualityStatus: null, qualityMarkedAt: null });
  });

  it("keeps unmarked accounts distinct from accounts explicitly marked normal", () => {
    expect(getAccountQualityStatus({})).toBeNull();
    expect(getAccountQualityStatus({ isDegraded: false })).toBeNull();
    expect(getAccountQualityStatus({ qualityStatus: null, isDegraded: true })).toBeNull();
    expect(getAccountQualityStatus({ qualityStatus: "normal" })).toBe("normal");
  });

  it("persists a custom label on a disabled account and returns the text on quota refresh", async () => {
    const qualityLabel = "中午未降智，下午突然降智";
    const response = await update({ qualityStatus: "custom", qualityLabel: `  ${qualityLabel}  ` });
    expect(response.status).toBe(200);
    const returned = (await response.json()).connection;
    await reopen();
    const saved = await db.getProviderConnectionById(account.id);
    expect(saved).toMatchObject({ qualityStatus: "custom", qualityLabel, qualityMarkedAt: returned.qualityMarkedAt, isActive: false, isDegraded: false });
    expect(withoutMarkerAndUpdateTime(saved)).toEqual(withoutMarkerAndUpdateTime(account));
    expect(getAccountQualityStatus(saved)).toBe("custom");
    expect(getAccountQualityLabel(saved)).toBe(qualityLabel);
    expect(getAccountQualityMarkedAt(saved)).toBe(returned.qualityMarkedAt);
    const { GET } = await import("@/app/api/providers/client/route.js");
    const data = await (await GET(new Request("http://localhost/api/providers/client?accountStatus=inactive"))).json();
    expect(data.connections[0]).toMatchObject({ qualityStatus: "custom", qualityLabel, qualityMarkedAt: returned.qualityMarkedAt });
    for (const secret of ["saved-access", "saved-refresh", "saved-id"]) expect(JSON.stringify(data)).not.toContain(secret);
  });

  it("records a new time when custom text changes, preserves identical text and clears text when choosing a preset or clearing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const first = "2026-10-13T04:00:00.000Z", next = "2026-10-13T07:00:00.000Z";
    vi.setSystemTime(new Date(first));
    await update({ qualityStatus: "custom", qualityLabel: "中午正常" });
    vi.setSystemTime(new Date(next));
    await update({ qualityStatus: "custom", qualityLabel: " 中午正常 " });
    expect((await db.getProviderConnectionById(account.id)).qualityMarkedAt).toBe(first);
    await update({ qualityStatus: "custom", qualityLabel: "下午突然降智" });
    expect((await db.getProviderConnectionById(account.id)).qualityMarkedAt).toBe(next);
    await update({ qualityStatus: "degraded" });
    expect(await db.getProviderConnectionById(account.id)).toMatchObject({ qualityStatus: "degraded", qualityLabel: null, isDegraded: true });
    await update({ qualityStatus: "custom", qualityLabel: "待观察" });
    await update({ isDegraded: false });
    expect(await db.getProviderConnectionById(account.id)).toMatchObject({ qualityStatus: null, qualityLabel: null, qualityMarkedAt: null });
  });

  it("keeps custom text through unrelated edits and preserves labels supplied on creation", async () => {
    await update({ qualityStatus: "custom", qualityLabel: "上午正常，下午待观察" });
    const before = await db.getProviderConnectionById(account.id);
    await update({ name: "Renamed" });
    expect(await db.getProviderConnectionById(account.id)).toMatchObject({ qualityStatus: "custom", qualityLabel: before.qualityLabel, qualityMarkedAt: before.qualityMarkedAt });
    const created = await db.createProviderConnection({ provider: "codex", authType: "oauth", name: "Custom", qualityStatus: "custom", qualityLabel: "待观察", qualityMarkedAt: before.qualityMarkedAt });
    await reopen();
    expect(await db.getProviderConnectionById(created.id)).toMatchObject({ qualityStatus: "custom", qualityLabel: "待观察", qualityMarkedAt: before.qualityMarkedAt });
  });

  it.each([undefined, null, "", "   ", true, 1, {}, [], "字".repeat(ACCOUNT_QUALITY_MAX_LENGTH + 1)])("rejects invalid custom text (%j) without other edits", async qualityLabel => {
    expect((await update({ qualityStatus: "custom", qualityLabel, name: "Should not save" })).status).toBe(400);
    expect(await db.getProviderConnectionById(account.id)).toEqual(account);
  });

  it("accepts the maximum label length and keeps user text as plain text", async () => {
    const qualityLabel = "字".repeat(ACCOUNT_QUALITY_MAX_LENGTH);
    expect((await update({ qualityStatus: "custom", qualityLabel })).status).toBe(200);
    expect(getAccountQualityLabel(await db.getProviderConnectionById(account.id))).toBe(qualityLabel);
    const html = '<img src=x onerror="alert(1)">';
    await update({ qualityStatus: "custom", qualityLabel: html });
    expect(getAccountQualityLabel(await db.getProviderConnectionById(account.id))).toBe(html);
  });

  it.each([{ qualityLabel: "待观察" }, { qualityStatus: "normal", qualityLabel: "待观察" }])("rejects ambiguous custom labels: %j", async patch => {
    expect((await update({ ...patch, name: "Should not save" })).status).toBe(400);
    expect(await db.getProviderConnectionById(account.id)).toEqual(account);
  });

  it.each(["unknown", "", true, false, 1, {}, [], "toString"])("rejects invalid quality status (%j) without applying other edits", async qualityStatus => {
    expect((await update({ qualityStatus, name: "Should not be saved" })).status).toBe(400);
    expect(await db.getProviderConnectionById(account.id)).toEqual(account);
  });

  it.each([
    { qualityStatus: "normal", isDegraded: true },
    { qualityStatus: "slow", isDegraded: true },
    { qualityStatus: "degraded", isDegraded: false },
  ])("rejects conflicting old and new marker fields: %j", async patch => {
    expect((await update(patch)).status).toBe(400);
    expect(await db.getProviderConnectionById(account.id)).toEqual(account);
  });
});
