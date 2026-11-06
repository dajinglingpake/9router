import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.hoisted(() => { process.env.JWT_SECRET = "my-account-test-secret-not-for-production"; });
vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn() }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyById: vi.fn(), getApiKeyByValue: vi.fn() }));
vi.mock("@/lib/db/repos/connectionsRepo.js", () => ({ getProviderConnections: vi.fn() }));
vi.mock("@/lib/providerUsage.js", () => ({ loadConnectionUsage: vi.fn(), supportsConnectionUsage: vi.fn(() => true) }));
vi.mock("@/sse/utils/clientIp.js", () => ({ extractClientIp: vi.fn(() => "192.0.2.1") }));
vi.mock("@/sse/services/model.js", () => ({ getModelInfo: vi.fn(), getComboModels: vi.fn() }));

import { getApiKeyById, getApiKeyByValue } from "@/lib/db/repos/apiKeysRepo.js";
import { getProviderConnections } from "@/lib/db/repos/connectionsRepo.js";
import { loadConnectionUsage, supportsConnectionUsage } from "@/lib/providerUsage.js";
import { extractClientIp } from "@/sse/utils/clientIp.js";
import { createMyAccountToken, createDashboardAuthToken, verifyDashboardAuthToken } from "@/lib/auth/dashboardSession.js";
import { GET, POST } from "@/app/api/my-account/route.js";
import { getModelInfo, getComboModels } from "@/sse/services/model.js";

let key;
function request(token, method = "GET", query = "") {
  return new Request(`http://router/api/my-account${query}`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
}
async function viewToken() { return createMyAccountToken(key); }

beforeEach(() => {
  vi.clearAllMocks();
  key = { id: "key-a", key: "secret-a", name: "用户甲", isActive: true, allowedIps: ["192.0.2.1"] };
  getApiKeyByValue.mockImplementation(async value => value === key.key ? key : null);
  getApiKeyById.mockImplementation(async id => id === key.id ? key : null);
  extractClientIp.mockReturnValue("192.0.2.1");
  getComboModels.mockResolvedValue(null);
  getModelInfo.mockImplementation(async model => ({ provider: model.split("/")[0] }));
  supportsConnectionUsage.mockReturnValue(true);
  getProviderConnections.mockResolvedValue([
    { id: "account-a", provider: "codex", name: "我的账号", exclusiveApiKeyIds: ["key-a"], accessToken: "upstream-secret", email: "private@example.com" },
    { id: "account-b", provider: "kimi", name: "别人的账号", exclusiveApiKeyIds: ["key-b"] },
    { id: "shared", provider: "codex", authType: "oauth", name: "共享池的账号" },
  ]);
  loadConnectionUsage.mockResolvedValue({
    plan: "Plus", accessToken: "not-for-client", raw: { secret: "not-for-client" },
    quotas: { session: { used: 30, total: 100, remaining: 70, resetAt: "2026-11-06T12:00:00Z", secret: "not-for-client" } },
  });
});
afterEach(() => vi.useRealTimers());

describe("my account sessions", () => {
  it("exchanges only a valid, active, IP-authorized key and disables caching", async () => {
    const response = await POST(request(key.key, "POST"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json();
    expect(body.expiresIn).toBe(1800);
    expect(body.token).not.toContain(key.key);
    expect((await POST(request("wrong", "POST"))).status).toBe(401);
    key.isActive = false;
    expect((await POST(request(key.key, "POST"))).status).toBe(401);
    key.isActive = true;
    extractClientIp.mockReturnValue("192.0.2.2");
    expect((await POST(request(key.key, "POST"))).status).toBe(401);
  });

  it("never accepts admin cookies, query credentials, raw keys or an admin JWT for viewing", async () => {
    for (const token of [null, key.key, await createDashboardAuthToken()]) {
      expect((await GET(request(token))).status).toBe(401);
    }
    expect((await GET(request(null, "GET", `?key=${await viewToken()}`))).status).toBe(401);
    expect(await verifyDashboardAuthToken(await viewToken())).toBe(false);
    expect(loadConnectionUsage).not.toHaveBeenCalled();
  });

  it("revokes a view token on expiry, key rotation, disable, deletion and IP changes", async () => {
    const token = await viewToken();
    key.isActive = false;
    expect((await GET(request(token))).status).toBe(401);
    key.isActive = true;
    key.key = "rotated-key";
    expect((await GET(request(token))).status).toBe(401);
    key.key = "secret-a";
    extractClientIp.mockReturnValue("192.0.2.2");
    expect((await GET(request(token))).status).toBe(401);
    extractClientIp.mockReturnValue("192.0.2.1");
    getApiKeyById.mockResolvedValueOnce(null);
    expect((await GET(request(token))).status).toBe(401);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 1801_000);
    expect((await GET(request(token))).status).toBe(401);
    expect(loadConnectionUsage).not.toHaveBeenCalled();
  });
});

describe("my account data isolation", () => {
  it("returns only the key's bound account with an explicit safe field list", async () => {
    const response = await GET(request(await viewToken(), "GET", "?connectionId=account-b&apiKeyId=key-b"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.binding).toBe("dedicated");
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toMatchObject({ id: "account-a", name: "我的账号", quotas: [{ name: "5h", remainingPercentage: 70 }] });
    const serialized = JSON.stringify(body);
    for (const secret of ["upstream-secret", "secret-a", "not-for-client", "private@example.com", "account-b", "共享池"]) expect(serialized).not.toContain(secret);
    expect(loadConnectionUsage).toHaveBeenCalledTimes(1);
    expect(loadConnectionUsage.mock.calls[0][0].id).toBe("account-a");
  });

  it("shows shared Codex quota anonymously when there is no dedicated binding", async () => {
    key.id = "unbound";
    const body = await (await GET(request(await viewToken()))).json();
    expect(body.binding).toBe("shared");
    expect(body.accounts.map(a => a.id)).toEqual(["codex-shared"]);
    expect(body.accounts[0].shared).toBe(true);
    expect(body.accounts[0].name).toBe("Codex 共享总额度");
    expect(body.accounts[0].name).not.toBe("共享池的账号");
    expect(body.accounts[0].codexSummary).toMatchObject({ accountCount: 1, sharedAccountCount: 1, dedicatedAccountCount: 0 });
    expect(loadConnectionUsage).toHaveBeenCalledTimes(1);
  });

  it("includes shared Kimi beside dedicated Codex, hides other owners and disabled shared accounts", async () => {
    const connections = await getProviderConnections();
    getProviderConnections.mockResolvedValue([...connections,
      { id: "shared-kimi", provider: "kimi", name: "secret shared login", exclusiveApiKeyIds: [] },
      { id: "off", provider: "kimi", isActive: false },
    ]);
    const body = await (await GET(request(await viewToken()))).json();
    expect(body.accounts.map(a => [a.id, a.shared])).toEqual([["account-a", false], ["shared-kimi", true]]);
    expect(JSON.stringify(body)).not.toContain("secret shared login");
  });

  it("restricts shared quota visibility by allowed models and nested combos", async () => {
    key.id = "unbound";
    key.access = { restricted: true, allow: [] };
    expect((await (await GET(request(await viewToken()))).json()).accounts).toEqual([]);
    key.access.allow = ["KimiCombo"];
    getComboModels.mockImplementation(async model => model === "KimiCombo" ? ["Nested"] : model === "Nested" ? ["kimi/k3.1-pro", "KimiCombo"] : null);
    const connections = await getProviderConnections();
    getProviderConnections.mockResolvedValue([...connections, { id: "shared-kimi", provider: "kimi" }]);
    const body = await (await GET(request(await viewToken()))).json();
    expect(body.accounts.map(a => a.id)).toEqual(["shared-kimi"]);
  });

  it("supports legacy binding, disabled accounts and partial quota failure without leaking errors", async () => {
    getProviderConnections.mockResolvedValue([
      { id: "old", provider: "codex", exclusiveApiKeyId: "key-a", isActive: false },
      { id: "kimi", provider: "kimi", exclusiveApiKeyIds: ["key-a", "key-c"] },
      { id: "unsupported", provider: "other", exclusiveApiKeyId: "key-a" },
    ]);
    supportsConnectionUsage.mockImplementation(c => c.provider !== "other");
    loadConnectionUsage.mockRejectedValueOnce(new Error("access_token=upstream-secret"));
    loadConnectionUsage.mockResolvedValueOnce({ quotas: { "Monthly (Total)": { used: 20, total: 100 } }, usageBreakdown: { monthlyCodeUsedPercentage: 15 } });
    const body = await (await GET(request(await viewToken()))).json();
    expect(body.accounts).toHaveLength(3);
    expect(body.accounts[0]).toMatchObject({ active: false, quotas: [], message: expect.any(String) });
    expect(body.accounts[1]).toMatchObject({ monthlyCodeUsedPercentage: 15, quotas: [{ remainingPercentage: 80 }] });
    expect(body.accounts[2].message).toContain("不提供");
    expect(JSON.stringify(body)).not.toContain("upstream-secret");
  });

  it("rejects results if the key was disabled while quota loading", async () => {
    loadConnectionUsage.mockImplementationOnce(async () => { key.isActive = false; return {}; });
    expect((await GET(request(await viewToken()))).status).toBe(401);
  });

  it("does not return an account that was rebound while quota loading", async () => {
    loadConnectionUsage.mockImplementationOnce(async () => {
      getProviderConnections.mockResolvedValue([]);
      return { quotas: { session: { used: 30, total: 100 } } };
    });
    const body = await (await GET(request(await viewToken()))).json();
    expect(body).toMatchObject({ binding: "shared", accounts: [] });
  });
});

describe("my account shared Codex totals", () => {
  const connection = (id, extra = {}) => ({ id, provider: "codex", authType: "oauth", name: `private-${id}`, ...extra });
  const usage = (session, weekly, plan = "plus") => ({ plan, quotas: {
    session: { used: 100 - session, total: 100, windowSeconds: 18000 },
    weekly: { used: 100 - weekly, total: 100, windowSeconds: 604800 },
  } });

  it("returns one pool card with the tracker's per-plan totals, without individual accounts or credits", async () => {
    key.id = "unbound";
    getProviderConnections.mockResolvedValue([
      connection("plus-one"), connection("plus-two"), connection("pro"),
      connection("off", { isActive: false }), connection("dedicated", { exclusiveApiKeyIds: ["key-b"] }),
      { id: "shared-kimi", provider: "kimi", authType: "oauth" },
    ]);
    loadConnectionUsage.mockImplementation(async c => ({
      ...({ "plus-one": usage(80, 20), "plus-two": usage(40, 80), pro: usage(10, 50, "pro") }[c.id] || {}),
      raw: { accessToken: "upstream-secret" },
    }));
    const body = await (await GET(request(await viewToken()))).json();
    expect(body.accounts.map(a => a.id)).toEqual(["codex-shared", "shared-kimi"]);
    const pool = body.accounts[0];
    expect(pool.quotas).toEqual([]);
    expect(pool.codexSummary).toMatchObject({ accountCount: 3, sharedAccountCount: 3, dedicatedAccountCount: 0, unknownAccounts: 0 });
    expect(pool.codexSummary.groups).toHaveLength(2);
    expect(pool.codexSummary.groups[0]).toMatchObject({
      key: "shared:plus", accountCount: 2,
      session: { remainingPercent: 60, equivalentAccounts: expect.closeTo(1.2), knownAccounts: 2 },
      weekly: { remainingPercent: 50, equivalentAccounts: 1, knownAccounts: 2 },
    });
    expect(pool.codexSummary.groups[1]).toMatchObject({ key: "shared:pro", session: { remainingPercent: 10 } });
    expect(loadConnectionUsage.mock.calls.map(([c]) => c.id)).toEqual(["plus-one", "plus-two", "pro", "shared-kimi"]);
    for (const secret of ["private-", "plus-one", "plus-two", "upstream-secret", "exclusiveApiKey", "Credits"]) {
      expect(JSON.stringify(body)).not.toContain(secret);
    }
  });

  it("keeps failed and expired quota queries unknown instead of treating them as full or empty", async () => {
    key.id = "unbound";
    getProviderConnections.mockResolvedValue([connection("known"), connection("expired"), connection("failed")]);
    loadConnectionUsage.mockImplementation(async c => {
      if (c.id === "failed") throw new Error("upstream-secret");
      const data = usage(80, 60);
      if (c.id === "expired") data.quotas.session.resetAt = "2000-01-01T00:00:00Z";
      return data;
    });
    const body = await (await GET(request(await viewToken()))).json();
    const summary = body.accounts[0].codexSummary;
    expect(summary).toMatchObject({ accountCount: 3, unknownAccounts: 2 });
    expect(summary.groups.find(g => g.plan === "plus")).toMatchObject({
      session: { accountCount: 2, knownAccounts: 1, remainingPercent: 80 },
      weekly: { accountCount: 2, knownAccounts: 2, remainingPercent: 60 },
    });
    expect(summary.groups.find(g => g.plan === "unknown")).toMatchObject({
      session: { knownAccounts: 0, remainingPercent: null }, weekly: { knownAccounts: 0, remainingPercent: null },
    });
    expect(JSON.stringify(body)).not.toContain("upstream-secret");
  });

  it("does not invent a five-hour quota for weekly-only accounts", async () => {
    key.id = "unbound";
    getProviderConnections.mockResolvedValue([connection("weekly-only")]);
    loadConnectionUsage.mockResolvedValue({ plan: "free", quotas: { weekly: { used: 25, total: 100, windowSeconds: 604800 } } });
    const body = await (await GET(request(await viewToken()))).json();
    expect(body.accounts[0].codexSummary.groups[0]).toMatchObject({
      session: { accountCount: 0, knownAccounts: 0, remainingPercent: null },
      weekly: { accountCount: 1, knownAccounts: 1, remainingPercent: 75 },
    });
  });

  it("excludes accounts made private while shared quota queries were running", async () => {
    key.id = "unbound";
    getProviderConnections.mockResolvedValue([connection("remains-shared"), connection("rebound")]);
    loadConnectionUsage.mockImplementation(async c => {
      getProviderConnections.mockResolvedValue([
        connection("remains-shared"), connection("rebound", { exclusiveApiKeyIds: ["key-b"] }),
      ]);
      return usage(c.id === "rebound" ? 0 : 80, 50);
    });
    const body = await (await GET(request(await viewToken()))).json();
    expect(body.accounts[0].codexSummary).toMatchObject({
      accountCount: 1, groups: [{ session: { remainingPercent: 80 } }],
    });
    expect(JSON.stringify(body)).not.toContain("rebound");
  });
});
