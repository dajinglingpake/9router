import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/providerUsage", () => ({ refreshAndUpdateCredentials: vi.fn(async connection => ({ connection, refreshed: false })) }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn(async () => ({})) }));
const previousDataDir = process.env.DATA_DIR;
let directory, db, bulk, single, download, source, listeners;
const jwt = value => `header.${Buffer.from(JSON.stringify(value)).toString("base64url")}.signature`;
const post = value => new Request("http://localhost/api/oauth/codex/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });

beforeEach(async () => {
  listeners = Object.fromEntries(["beforeExit", "exit", "SIGINT", "SIGTERM"].map(event => [event, new Set(process.rawListeners(event))]));
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "9router-session-import-"));
  process.env.DATA_DIR = directory; delete global._dbAdapter; vi.resetModules();
  db = await import("@/lib/db/index.js"); await db.initDb();
  bulk = await import("@/app/api/oauth/codex/bulk-import/route.js");
  single = await import("@/app/api/oauth/codex/import-token/route.js");
  download = await import("@/app/api/providers/[id]/session-export/route.js");
  source = { user: { id: "user-1", email: "owner@example.com", amr: ["pwd"], mfa: true },
    account: { id: "workspace-1", planType: "plus", residencyRegion: "us", isDelinquent: false },
    accessToken: jwt({ exp: 2000000000, "https://api.openai.com/auth": { chatgpt_account_id: "workspace-1" } }),
    sessionToken: "private-web-session", authProvider: "openai", expires: "2030-01-01T00:00:00Z",
    statsigContext: { deviceId: "private-device" }, marketingEligibility: { example: { events: { signup: { keep: true } } } },
    futureField: [true, { nested: "keep" }],
  };
});
afterEach(() => {
  global._dbAdapter?.instance?.close?.(); delete global._dbAdapter;
  for (const [event, original] of Object.entries(listeners)) {
    for (const listener of process.rawListeners(event)) if (!original.has(listener)) process.removeListener(event, listener);
  }
  fs.rmSync(directory, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
});
async function exported(id) {
  const response = await download.GET(new Request("http://localhost/session-export"), { params: Promise.resolve({ id }) });
  expect(response.status).toBe(200);
  return response.json();
}

describe("Session imports survive database persistence and TXT export", () => {
  it("round-trips every field from a single full Session through bulk import", async () => {
    const result = await (await bulk.POST(post(source))).json();
    expect(result).toMatchObject({ success: 1, failed: 0 });
    const id = result.results[0].id;
    const saved = await db.getProviderConnectionById(id);
    expect(JSON.parse(saved.chatgptSession.raw)).toEqual(source);
    expect(await exported(id)).toEqual(source);
    expect(JSON.stringify(result)).not.toContain("private-web-session");
  });

  it.each(["direct", "wrapped", "text"])("supports %s Session imports through the existing import-token endpoint", async mode => {
    const body = mode === "direct" ? source : { session: mode === "text" ? JSON.stringify(source) : source, name: "Imported account" };
    const response = await single.POST(post(body));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(await exported(result.connection.id)).toEqual(source);
    expect(JSON.stringify(result)).not.toContain("private-web-session");
  });

  it("keeps plain token imports on the existing generated Session format", async () => {
    const accessToken = jwt({ exp: 2000000000, "https://api.openai.com/profile": { email: source.user.email },
      "https://api.openai.com/auth": { chatgpt_account_id: "workspace-1", chatgpt_plan_type: "plus" } });
    const response = await single.POST(post({ accessToken, name: "Legacy token" }));
    expect(response.status).toBe(200);
    const { connection } = await response.json();
    expect((await db.getProviderConnectionById(connection.id)).chatgptSession).toBeUndefined();
    expect(await exported(connection.id)).toMatchObject({ user: { email: source.user.email }, accessToken, account: { id: "workspace-1" } });
  });

  it("accepts mixed batches without dropping full Session data", async () => {
    const token = jwt({ exp: 2000000000, "https://api.openai.com/profile": { email: "token@example.com" } });
    const result = await (await bulk.POST(post({ accounts: [source, token, { refreshToken: "missing-access" }] }))).json();
    expect(result).toMatchObject({ success: 2, failed: 1 });
    expect(await exported(result.results[0].id)).toEqual(source);
    expect((await exported(result.results[1].id)).accessToken).toBe(token);
  });

  it("can import into an existing account while preserving its configuration", async () => {
    const existing = await db.createProviderConnection({ provider: "codex", authType: "oauth", name: "My account", email: source.user.email,
      accessToken: "old-access", refreshToken: "old-refresh", providerSpecificData: { chatgptAccountId: "workspace-1", proxyPoolId: "keep-proxy" }, priority: 5 });
    await db.updateProviderConnection(existing.id, { maxConcurrency: 3 });
    const response = await single.POST(post({ session: source, connectionId: existing.id }));
    expect(response.status).toBe(200);
    const saved = await db.getProviderConnectionById(existing.id);
    expect(saved).toMatchObject({ id: existing.id, name: "My account", maxConcurrency: 3,
      providerSpecificData: { proxyPoolId: "keep-proxy" }, refreshToken: null });
    expect(await db.getProviderConnections({ provider: "codex" })).toHaveLength(1);
    expect(await exported(existing.id)).toEqual(source);
  });

  it("rejects a malformed full Session without inserting a partial account", async () => {
    const invalid = { ...source, user: null };
    const response = await single.POST(post(invalid));
    expect(response.status).toBe(409);
    const result = await (await bulk.POST(post(invalid))).json();
    expect(result).toMatchObject({ success: 0, failed: 1 });
    expect(await db.getProviderConnections({ provider: "codex" })).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("private-web-session");
  });
});
