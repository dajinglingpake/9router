import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { upstream } = vi.hoisted(() => ({ upstream: vi.fn() }));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: upstream }));

const originalDataDir = process.env.DATA_DIR;
let tempDir, db, models, originalListeners;

beforeEach(async () => {
  originalListeners = Object.fromEntries(["beforeExit", "SIGINT", "SIGTERM"].map(event => [event, new Set(process.rawListeners(event))]));
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-combo-activation-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  upstream.mockReset();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({ requireApiKey: false });
  models = await import("@/sse/services/model.js");
});

afterEach(() => {
  global._dbAdapter?.instance?.close?.();
  delete global._dbAdapter;
  for (const [event, listeners] of Object.entries(originalListeners)) {
    for (const listener of process.rawListeners(event)) {
      if (!listeners.has(listener)) process.removeListener(event, listener);
    }
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("combo activation", () => {
  it("defaults existing and new combos to active, preserving models and overrides when toggled", async () => {
    expect((await db.getComboByName("gpt-6.1-sol")).isActive).toBe(true);
    const combo = await db.createCombo({ name: "toggle-test", models: ["cx/gpt-6.1-sol"] });
    expect(combo.isActive).toBe(true);
    await db.updateCombo(combo.id, { accountOverrides: { account1: ["cx/gpt-6-luna"] }, isActive: false });
    expect(await db.getComboByName(combo.name)).toMatchObject({
      isActive: false, models: combo.models, accountOverrides: { account1: ["cx/gpt-6-luna"] },
    });
    await db.updateCombo(combo.id, { isActive: true });
    expect((await db.getComboById(combo.id)).isActive).toBe(true);
  });

  it("keeps disabled default combos disabled after a database restart and default seeding", async () => {
    const combo = await db.getComboByName("gpt-6.1-sol");
    await db.updateCombo(combo.id, { isActive: false });
    global._dbAdapter.instance.close();
    delete global._dbAdapter;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    await db.initDb();
    expect(await db.getComboById(combo.id)).toMatchObject({ isActive: false, models: combo.models });
  });

  it("round-trips activation in backups and treats legacy backups as enabled", async () => {
    const combo = await db.createCombo({ name: "backup-test", models: ["cx/gpt-6.1-sol"], isActive: false });
    const backup = await db.exportDb();
    await db.updateCombo(combo.id, { isActive: true });
    await db.importDb(backup);
    expect((await db.getComboById(combo.id)).isActive).toBe(false);
    for (const item of backup.combos) delete item.isActive;
    await db.importDb(backup);
    expect((await db.getComboById(combo.id)).isActive).toBe(true);
  });

  it("does not infer a provider for disabled bare or cc combo names", async () => {
    const combo = await db.getComboByName("gpt-6.1-sol");
    await db.updateCombo(combo.id, { isActive: false });
    for (const name of [combo.name, `cc/${combo.name}`]) {
      expect(await models.getComboModels(name)).toEqual([]);
      expect(await models.getModelInfo(name)).toMatchObject({ provider: null, disabled: true });
    }
    expect(await models.getModelInfo("cx/gpt-6.1-sol")).toEqual({ provider: "codex", model: "gpt-6.1-sol" });
    await db.updateCombo(combo.id, { isActive: true });
    expect(await models.getComboModels(combo.name)).toEqual(combo.models);
  });

  it("validates and persists activation through the management API", async () => {
    const { PUT } = await import("../../src/app/api/combos/[id]/route.js");
    const combo = await db.getComboByName("gpt-6.1-sol");
    const update = isActive => PUT(new Request(`http://localhost/api/combos/${combo.id}`, {
      method: "PUT", body: JSON.stringify({ isActive }),
    }), { params: Promise.resolve({ id: combo.id }) });
    const response = await update(false);
    expect(response.status).toBe(200);
    expect((await response.json()).isActive).toBe(false);
    expect((await update("false")).status).toBe(400);
    expect((await db.getComboById(combo.id)).isActive).toBe(false);
    expect((await update(true)).status).toBe(200);
    expect((await db.getComboById(combo.id)).isActive).toBe(true);
  });

  it.each([
    ["gpt-6.1-sol", "hello", "test-client"],
    ["cc/gpt-6.1-sol", "hello", "test-client"],
    ["gpt-6.1-sol", "Warmup", "claude-cli"],
    ["outer-combo", "hello", "test-client"],
  ])("rejects %s (%s) before invoking any upstream", async (name, content, userAgent) => {
    const combo = await db.getComboByName("gpt-6.1-sol");
    await db.updateCombo(combo.id, { isActive: false });
    await db.createCombo({ name: "outer-combo", models: [combo.name] });
    const { handleChat } = await import("@/sse/local/chat.js");
    const response = await handleChat(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", "User-Agent": userAgent },
      body: JSON.stringify({ model: name, stream: false, messages: [{ role: "user", content }] }),
    }));
    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toContain("已禁用");
    expect(upstream).not.toHaveBeenCalled();
  });
});
