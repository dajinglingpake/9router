import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { upstream, router } = vi.hoisted(() => ({ upstream: vi.fn(), router: vi.fn() }));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: upstream }));
vi.mock("open-sse/handlers/systemoneCore.js", () => ({ handleSystemoneCore: router }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: async (_p, c) => c, updateProviderCredentials: vi.fn() }));
vi.mock("@/lib/providerUsage.js", () => ({ loadConnectionUsage: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/alerts/wecom.js", () => ({ notifyRequestError: vi.fn().mockResolvedValue(undefined) }));

const originalDataDir = process.env.DATA_DIR;
let tempDir, db, models, originalListeners;

beforeEach(async () => {
  originalListeners = Object.fromEntries(["beforeExit", "SIGINT", "SIGTERM"].map(event => [event, new Set(process.rawListeners(event))]));
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-combo-activation-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  upstream.mockReset().mockImplementation(async () => ({ success: true, response: Response.json({ ok: true }) }));
  router.mockReset();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({ requireApiKey: false });
  models = await import("@/sse/services/model.js");
});

afterEach(async () => {
  await global._requestErrorWrites?.pending;
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

async function whitelistFixture() {
  const owner = await db.createApiKey("allowed-key", "test-machine");
  const other = await db.createApiKey("other-key", "test-machine");
  await db.createProviderConnection({ provider: "openai", authType: "apikey", apiKey: "upstream-test-key", name: "test-account" });
  const combo = await db.createCombo({ name: "private-combo", models: ["openai/test-model"], isActive: false, allowedApiKeyIds: [owner.id] });
  return { owner, other, combo };
}

async function send(model, key, { header = "Authorization", query = false, headers = {}, endpoint = "/v1/chat/completions" } = {}) {
  if (key && !query) headers[header] = header === "Authorization" ? `Bearer ${key}` : key;
  const url = `http://localhost${endpoint}${query && key ? `?key=${encodeURIComponent(key)}` : ""}`;
  const { handleChat } = await import("@/sse/local/chat.js");
  return handleChat(new Request(url, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: "hello" }] }),
  }));
}

describe("upstream features through local combo routing", () => {
  it("keeps smart routing sticky per API key and uses each caller's exclusive router account", async () => {
    const owner = await db.createApiKey("smart-owner", "test-machine");
    const other = await db.createApiKey("smart-other", "test-machine");
    const accounts = [];
    for (const key of [owner, other]) {
      accounts.push(await db.createProviderConnection({
        provider: "openai", authType: "apikey", apiKey: "upstream-test-key", name: key.name,
        exclusiveApiKeyIds: [key.id],
      }));
    }
    await db.createCombo({ name: "smart", models: ["openai/model-a", "openai/model-b"] });
    await db.updateSettings({ comboStrategies: { smart: { fallbackStrategy: "smart", smartPolicy: "strict", routerModel: "openai/router" } } });
    router.mockImplementation(async ({ credentials }) => ({
      success: true,
      response: Response.json({ answers: { route: {
        choice: credentials.connectionId === accounts[0].id ? "openai/model-b" : "openai/model-a",
        confidence: 0.95,
      } } }),
    }));
    for (const key of [owner, owner, other]) {
      const response = await send("cc/smart", key.key, { headers: { "x-session-id": "same-client-session" } });
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(router).toHaveBeenCalledTimes(2);
    expect(router.mock.calls.map(([args]) => args.credentials.connectionId)).toEqual(accounts.map(account => account.id));
    expect(upstream.mock.calls.map(([args]) => args.modelInfo.model)).toEqual(["model-b", "model-b", "model-a"]);
    expect(upstream.mock.calls.map(([args]) => args.credentials.connectionId)).toEqual([accounts[0].id, accounts[0].id, accounts[1].id]);
  });

  it("falls back to normal combo order when the decision model fails", async () => {
    await db.createProviderConnection({ provider: "openai", authType: "apikey", apiKey: "test", name: "router" });
    await db.createCombo({ name: "smart-fallback", models: ["openai/model-a", "openai/model-b"] });
    await db.updateSettings({ comboStrategies: { "smart-fallback": { fallbackStrategy: "smart", routerModel: "openai/router" } } });
    router.mockRejectedValue(new Error("decision service unavailable"));
    const response = await send("smart-fallback");
    expect(response.status).toBe(200);
    await response.text();
    expect(router).toHaveBeenCalledOnce();
    expect(upstream).toHaveBeenCalledWith(expect.objectContaining({ modelInfo: { provider: "openai", model: "model-a" } }));
  });

  it("passes the configured prompt through local routing and advances past request-scoped errors", async () => {
    const account = await db.createProviderConnection({ provider: "openai", authType: "apikey", apiKey: "test", name: "shared" });
    await db.createCombo({ name: "fallback", models: ["openai/model-a", "openai/model-b"] });
    await db.updateSettings({ customPromptEnabled: true, customPrompt: "Keep the configured instruction." });
    upstream.mockResolvedValueOnce({ success: false, status: 400, error: "unsupported parameter", response: Response.json({ error: "unsupported parameter" }, { status: 400 }) });
    const response = await send("fallback");
    expect(response.status).toBe(200);
    await response.text();
    expect(upstream.mock.calls.map(([args]) => args.modelInfo.model)).toEqual(["model-a", "model-b"]);
    for (const [args] of upstream.mock.calls) {
      expect(args).toMatchObject({ credentials: { connectionId: account.id }, customPromptEnabled: true, customPrompt: "Keep the configured instruction." });
    }
  });
});

describe("disabled combo API Key allowlist", () => {
  it.each(["private-combo", "cc/private-combo", "cc/private-combo[1m]"])("allows %s only for its listed active key", async name => {
    const { owner } = await whitelistFixture();
    const response = await send(name, owner.key);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(upstream).toHaveBeenCalledOnce();
  });

  it.each([
    { header: "x-api-key" }, { header: "x-goog-api-key" }, { query: true }, { endpoint: "/v1/responses" },
  ])("uses the authenticated key identity for %j", async options => {
    const { owner, combo } = await whitelistFixture();
    const response = await send(combo.name, owner.key, options);
    expect(response.status).toBe(200);
    await response.body.cancel();
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("blocks other, unknown, absent and disabled keys even when API Key authentication is optional", async () => {
    const { owner, other, combo } = await whitelistFixture();
    for (const key of [other.key, "invalid-key", null]) expect((await send(combo.name, key)).status).toBe(403);
    await db.updateApiKey(owner.id, { isActive: false });
    expect((await send(combo.name, owner.key)).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("retains the key's IP and model restrictions", async () => {
    const { owner, combo } = await whitelistFixture();
    await db.updateApiKey(owner.id, { allowedIps: ["192.0.2.1"] });
    expect((await send(combo.name, owner.key, { headers: { "x-real-ip": "192.0.2.2" } })).status).toBe(403);
    await db.updateApiKey(owner.id, { allowedIps: [], access: { restricted: true, allow: ["openai/test-model"] } });
    expect((await send(combo.name, owner.key)).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    await db.updateApiKey(owner.id, { access: { restricted: true, allow: [combo.name] } });
    const allowed = await send(`cc/${combo.name}`, owner.key);
    expect(allowed.status).toBe(200);
    await allowed.body.cancel();
    expect((await send("openai/test-model", owner.key)).status).toBe(403);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("checks nested disabled combos and applies allowlist removal immediately", async () => {
    const { owner, other, combo } = await whitelistFixture();
    await db.createCombo({ name: "outer", models: [`cc/${combo.name}`] });
    expect((await send("outer", other.key)).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    const allowed = await send("outer", owner.key);
    expect(allowed.status).toBe(200);
    await allowed.body.cancel();
    await db.updateCombo(combo.id, { allowedApiKeyIds: [] });
    expect((await send("outer", owner.key)).status).toBe(403);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("publishes disabled combo names and cc aliases only for allowed callers", async () => {
    const { owner, other, combo } = await whitelistFixture();
    const { GET } = await import("@/app/api/v1/models/route.js");
    const names = async key => {
      const response = await GET(new Request("http://localhost/v1/models", { headers: key ? { Authorization: `Bearer ${key}` } : {} }));
      expect(response.status).toBe(200);
      return (await response.json()).data.map(model => model.id);
    };
    expect(await names(owner.key)).toEqual(expect.arrayContaining([combo.name, `cc/${combo.name}`]));
    await db.updateApiKey(owner.id, { access: { restricted: true, allow: [combo.name] } });
    expect(await names(owner.key)).toEqual(expect.arrayContaining([combo.name, `cc/${combo.name}`]));
    for (const key of [other.key, null, "invalid-key"]) {
      const listed = await names(key);
      expect(listed).not.toContain(combo.name);
      expect(listed).not.toContain(`cc/${combo.name}`);
    }
    await db.updateApiKey(owner.id, { isActive: false });
    expect(await names(owner.key)).not.toContain(combo.name);
  });

  it("keeps enabled combos available to unlisted keys", async () => {
    const { other, combo } = await whitelistFixture();
    await db.updateCombo(combo.id, { isActive: true });
    const response = await send(combo.name, other.key);
    expect(response.status).toBe(200);
    await response.body.cancel();
  });

  it("validates and updates the allowlist without enabling the combo", async () => {
    const { owner, other, combo } = await whitelistFixture();
    const { PUT } = await import("@/app/api/combos/[id]/route.js");
    const update = allowedApiKeyIds => PUT(new Request(`http://localhost/api/combos/${combo.id}`, {
      method: "PUT", body: JSON.stringify({ allowedApiKeyIds }),
    }), { params: Promise.resolve({ id: combo.id }) });
    for (const invalid of [null, "key-id", [1], [""], ["missing-id"]]) expect((await update(invalid)).status).toBe(400);
    expect((await db.getComboById(combo.id)).allowedApiKeyIds).toEqual([owner.id]);
    expect((await update([owner.id, other.id, owner.id])).status).toBe(200);
    expect(await db.getComboById(combo.id)).toMatchObject({ isActive: false, allowedApiKeyIds: [owner.id, other.id] });
    expect((await update([])).status).toBe(200);
    expect(await db.getComboById(combo.id)).toMatchObject({ isActive: false, allowedApiKeyIds: [] });
  });

  it("creates combos with an allowlist through the management API", async () => {
    const { owner } = await whitelistFixture();
    const { POST } = await import("@/app/api/combos/route.js");
    const response = await POST(new Request("http://localhost/api/combos", {
      method: "POST", body: JSON.stringify({ name: "created-with-allowlist", models: ["openai/test-model"], isActive: false, allowedApiKeyIds: [owner.id] }),
    }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ isActive: false, allowedApiKeyIds: [owner.id] });
  });

  it("preserves allowlists in backups and restarts, and accepts legacy backups", async () => {
    const { owner, combo } = await whitelistFixture();
    const backup = await db.exportDb();
    await db.updateCombo(combo.id, { allowedApiKeyIds: [] });
    await db.importDb(backup);
    expect((await db.getComboById(combo.id)).allowedApiKeyIds).toEqual([owner.id]);
    global._dbAdapter.instance.close();
    delete global._dbAdapter;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    await db.initDb();
    expect(await db.getComboById(combo.id)).toMatchObject({ isActive: false, allowedApiKeyIds: [owner.id] });
    for (const item of backup.combos) delete item.allowedApiKeyIds;
    await db.importDb(backup);
    expect(await db.getComboById(combo.id)).toMatchObject({ isActive: false, allowedApiKeyIds: [] });
  });
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
