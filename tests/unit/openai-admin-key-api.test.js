import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/oauth/providers", () => ({ backfillCodexEmails: vi.fn() }));
vi.mock("@/lib/providerUsage.js", () => ({ loadConnectionUsage: vi.fn() }));
const originalDataDir = process.env.DATA_DIR;
const adminKey = "admin-secret-for-usage";
const modelKey = "model-secret-for-inference";
let tempDir, listeners, db, account, listConnections, createConnection, clientConnections, getConnection, updateConnection;
const context = id => ({ params: Promise.resolve({ id }) });
const request = (id, body) => new Request(`https://9router.local/api/providers/${id}`, {
  method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

beforeEach(async () => {
  listeners = Object.fromEntries(["beforeExit", "exit", "SIGINT", "SIGTERM"].map(event => [event, new Set(process.rawListeners(event))]));
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-openai-admin-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  account = await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "OpenAI test", apiKey: modelKey, testStatus: "active" });
  ({ GET: listConnections, POST: createConnection } = await import("@/app/api/providers/route.js"));
  ({ GET: clientConnections } = await import("@/app/api/providers/client/route.js"));
  ({ GET: getConnection, PUT: updateConnection } = await import("@/app/api/providers/[id]/route.js"));
});
afterEach(() => {
  global._dbAdapter?.instance?.close?.();
  delete global._dbAdapter;
  for (const [event, original] of Object.entries(listeners)) {
    for (const listener of process.rawListeners(event)) if (!original.has(listener)) process.removeListener(event, listener);
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("OpenAI Admin Key settings", () => {
  const create = (body) => createConnection(new Request("https://9router.local/api/providers", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "openai", name: "Created account", ...body }),
  }));

  it.each(["api-only", "admin-only", "both"])("creates %s accounts and never returns their secrets", async mode => {
    const response = await create({ apiKey: mode === "admin-only" ? "" : modelKey, openaiAdminKey: mode === "api-only" ? "" : adminKey });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.connection.hasOpenaiAdminKey).toBe(mode !== "api-only");
    expect(JSON.stringify(body)).not.toContain(adminKey);
    expect(JSON.stringify(body)).not.toContain(modelKey);
    const stored = await db.getProviderConnectionById(body.connection.id);
    expect(stored.apiKey).toBe(mode === "admin-only" ? "" : modelKey);
    if (mode !== "api-only") expect(stored.openaiAdminKey).toBe(adminKey);
  });

  it("rejects empty credentials and prevents clearing the only saved Admin Key", async () => {
    for (const body of [{}, { apiKey: "  ", openaiAdminKey: "  " }, { openaiAdminKey: {} }, { provider: "kimi", openaiAdminKey: adminKey }]) {
      expect((await create(body)).status).toBe(400);
    }
    const { connection } = await (await create({ openaiAdminKey: adminKey })).json();
    expect((await updateConnection(request(connection.id, { openaiAdminKey: null }), context(connection.id))).status).toBe(400);
    expect((await db.getProviderConnectionById(connection.id)).openaiAdminKey).toBe(adminKey);
    expect((await updateConnection(request(connection.id, { apiKey: modelKey, openaiAdminKey: null }), context(connection.id))).status).toBe(200);
  });

  it.each(["local", "legacy", "trial"])("excludes Admin-only accounts from %s model routing and allows adding a model key later", async kind => {
    const { connection } = await (await create({ openaiAdminKey: adminKey })).json();
    await db.updateProviderConnection(account.id, { isActive: false });
    const module = await import(kind === "local" ? "@/sse/local/accountSelection.js" : kind === "legacy" ? "@/sse/services/auth.js" : "@/sse/local/codexTrialSession.js");
    const getProviderCredentials = kind === "trial" ? () => module.getTrialCredentials({ connectionId: connection.id, provider: "openai", model: "gpt-6.1-sol" }) : module.getProviderCredentials;
    expect(await getProviderCredentials("openai", null, "gpt-6.1-sol")).toBeNull();
    await updateConnection(request(connection.id, { apiKey: modelKey }), context(connection.id));
    const credentials = await getProviderCredentials("openai", null, "gpt-6.1-sol");
    expect(credentials).toMatchObject({ connectionId: connection.id, apiKey: modelKey });
    expect(JSON.stringify(credentials)).not.toContain(adminKey);
    credentials.releaseSelection?.();
  });

  it("saves independently of the model key and hides both secrets from account responses", async () => {
    const saved = await updateConnection(request(account.id, { openaiAdminKey: ` ${adminKey} ` }), context(account.id));
    expect(saved.status).toBe(200);
    expect(await db.getProviderConnectionById(account.id)).toMatchObject({ openaiAdminKey: adminKey, apiKey: modelKey, testStatus: "active" });
    const responses = [saved, await listConnections(), await getConnection(null, context(account.id)),
      await clientConnections(new Request("https://9router.local/api/providers/client?provider=openai"))];
    for (const response of responses) {
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.connection || body.connections[0]).toMatchObject({ hasOpenaiAdminKey: true });
      expect(JSON.stringify(body)).not.toContain(adminKey);
      expect(JSON.stringify(body)).not.toContain(modelKey);
    }
  });

  it("retains a blank or omitted key, replaces a new value, and only clears on null", async () => {
    await updateConnection(request(account.id, { openaiAdminKey: adminKey }), context(account.id));
    for (const patch of [{ name: "renamed" }, { openaiAdminKey: "  " }]) {
      expect((await updateConnection(request(account.id, patch), context(account.id))).status).toBe(200);
      expect((await db.getProviderConnectionById(account.id)).openaiAdminKey).toBe(adminKey);
    }
    await updateConnection(request(account.id, { openaiAdminKey: "replacement" }), context(account.id));
    expect((await db.getProviderConnectionById(account.id)).openaiAdminKey).toBe("replacement");
    const cleared = await updateConnection(request(account.id, { openaiAdminKey: null }), context(account.id));
    expect((await cleared.json()).connection.hasOpenaiAdminKey).toBe(false);
    expect(await db.getProviderConnectionById(account.id)).toMatchObject({ openaiAdminKey: null, apiKey: modelKey });
  });

  it("rejects malformed keys and keys supplied for another provider without changing the account", async () => {
    for (const value of [false, {}, "bad\nkey", "x".repeat(1025)]) {
      expect((await updateConnection(request(account.id, { openaiAdminKey: value }), context(account.id))).status).toBe(400);
    }
    const other = await db.createProviderConnection({ provider: "kimi", authType: "apikey", name: "Other", apiKey: "other" });
    expect((await updateConnection(request(other.id, { openaiAdminKey: adminKey }), context(other.id))).status).toBe(400);
    expect(await db.getProviderConnectionById(account.id)).not.toHaveProperty("openaiAdminKey");
  });
});
