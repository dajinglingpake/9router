import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAccountPlan } from "@/lib/accountPlan.js";
import { getDisplayAccountPlan } from "@/shared/utils/accountPlan.js";
import { toProviderConnectionResponse } from "@/lib/providerConnectionResponse.js";

vi.mock("@/lib/oauth/providers", () => ({ backfillCodexEmails: vi.fn() }));
vi.mock("@/lib/alerts/wecom.js", () => ({ notifyRequestError: vi.fn().mockResolvedValue(undefined) }));
const jwt = payload => `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
const token = (plan, iat = 1791943200) => jwt({ iat, "https://api.openai.com/auth": { chatgpt_plan_type: plan }, privateField: "private-claim-data" });

describe("Codex plan identification", () => {
  it.each([["pro", "Pro"], ["PLUS", "Plus"], ["free", "免费版"], ["go", "Go"], ["team", "Team"], ["business", "Business"], ["enterprise", "Enterprise"], ["edu", "Edu"]])("reads the explicit %s plan from credentials", (type, label) => {
    const plan = getAccountPlan({ provider: "codex", idToken: token(type) });
    expect(plan).toEqual({ type: type.toLowerCase(), label, source: "credentials", checkedAt: new Date(1791943200000).toISOString() });
  });

  it("uses the newest valid claim and supports direct access-token plan claims", () => {
    const connection = { provider: "codex", idToken: token("plus", 1000), accessToken: jwt({ plan_type: "pro", iat: 2000 }), providerSpecificData: { chatgptPlanType: "free" } };
    expect(getAccountPlan(connection)).toMatchObject({ type: "pro", checkedAt: new Date(2000000).toISOString() });
    expect(getAccountPlan({ ...connection, idToken: token("free", 3000) }).type).toBe("free");
  });

  it("uses stored authorization metadata when no usable claim is available", () => {
    expect(getAccountPlan({ provider: "codex", idToken: "malformed", providerSpecificData: { chatgptPlanType: " plus " } })).toEqual({ type: "plus", label: "Plus", source: "account", checkedAt: null });
    expect(getAccountPlan({ provider: "codex", idToken: token("pro", 1e100) })).toMatchObject({ type: "pro", checkedAt: null });
  });

  it.each([undefined, null, "", "unknown", "private-token-value", true, 123, {}, []])("does not guess free from absent or unrecognized metadata: %j", value => {
    const connection = { provider: "codex", idToken: token(value), providerSpecificData: { chatgptPlanType: value }, quotas: { session: { total: 100 } } };
    expect(getAccountPlan(connection)).toEqual({ type: "unknown", label: "套餐未知", source: null, checkedAt: null });
  });

  it("does not label other providers as ChatGPT subscriptions", () => {
    expect(getAccountPlan({ provider: "claude", idToken: token("pro") })).toBeNull();
    expect(getDisplayAccountPlan({ provider: "claude", accountPlan: { type: "pro" } }, { plan: "pro" })).toBeNull();
  });

  it("prefers a newer explicit quota plan, including free, and ignores older cached quota data", () => {
    const connection = { provider: "codex", accountPlan: { type: "plus", source: "credentials", checkedAt: "2026-10-14T02:00:00.000Z" } };
    expect(getDisplayAccountPlan(connection, { plan: "pro", cachedAt: "2026-10-14T03:00:00.000Z" })).toMatchObject({ type: "pro", source: "usage" });
    expect(getDisplayAccountPlan(connection, { plan: "free", cachedAt: "2026-10-14T03:00:00.000Z" })).toMatchObject({ type: "free", label: "免费版", source: "usage" });
    expect(getDisplayAccountPlan(connection, { plan: "free", cachedAt: "2026-10-14T01:00:00.000Z" })).toMatchObject({ type: "plus", source: "credentials" });
    expect(getDisplayAccountPlan(connection, { plan: "unknown" })).toMatchObject({ type: "plus", source: "credentials" });
    expect(getDisplayAccountPlan({ provider: "codex" }, { message: "Usage unavailable" }).type).toBe("unknown");
  });

  it("returns only safe plan metadata while keeping account credentials hidden", () => {
    const connection = { id: "test-account", provider: "codex", idToken: token("pro"), accessToken: "private-access", refreshToken: "private-refresh", apiKey: "private-api-key" };
    const response = toProviderConnectionResponse(connection);
    expect(response.accountPlan).toMatchObject({ type: "pro", label: "Pro" });
    const text = JSON.stringify(response);
    for (const secret of [connection.idToken, connection.accessToken, connection.refreshToken, connection.apiKey, "private-claim-data"]) expect(text).not.toContain(secret);
    expect(getDisplayAccountPlan({ provider: "codex", accountPlan: { type: "pro", label: "private-label", private: "private-value", source: "private-source", checkedAt: "invalid" } })).toEqual({ type: "pro", label: "Pro", source: null, checkedAt: null });
  });
});

describe("account plans in list and diagnostics APIs", () => {
  const originalDataDir = process.env.DATA_DIR;
  let db, tempDir, account, listeners;
  beforeEach(async () => {
    listeners = Object.fromEntries(["beforeExit", "exit", "SIGINT", "SIGTERM"].map(event => [event, new Set(process.rawListeners(event))]));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-account-plan-"));
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    await db.initDb();
    account = await db.createProviderConnection({ provider: "codex", authType: "oauth", name: "plan-test-account", isActive: false,
      idToken: token("pro"), accessToken: "private-access", refreshToken: "private-refresh", exclusiveApiKeyIds: [],
      qualityStatus: "custom", qualityLabel: "继续观察", qualityColor: "#15803d", providerSpecificData: { chatgptPlanType: "plus" } });
  });
  afterEach(async () => {
    await global._requestErrorWrites?.pending;
    global._dbAdapter?.instance?.close?.();
    delete global._dbAdapter;
    for (const [event, original] of Object.entries(listeners)) for (const listener of process.rawListeners(event)) if (!original.has(listener)) process.removeListener(event, listener);
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = originalDataDir;
  });

  it("returns the saved plan for disabled accounts in account, provider and quota lists without changing configuration", async () => {
    const before = await db.getProviderConnectionById(account.id);
    const quota = await import("@/app/api/providers/client/route.js");
    const providers = await import("@/app/api/providers/route.js");
    const single = await import("@/app/api/providers/[id]/route.js");
    const responses = [await quota.GET(new Request("http://localhost/api/providers/client?accountStatus=inactive")), await providers.GET(), await single.GET(new Request("http://localhost/api/providers/" + account.id), { params: Promise.resolve({ id: account.id }) })];
    for (const response of responses) {
      expect(response.status).toBe(200);
      const data = await response.json();
      expect((data.connection || data.connections.find(a => a.id === account.id)).accountPlan).toMatchObject({ type: "pro", label: "Pro", source: "credentials" });
      for (const secret of [account.idToken, "private-access", "private-refresh", "private-claim-data"]) expect(JSON.stringify(data)).not.toContain(secret);
    }
    expect(await db.getProviderConnectionById(account.id)).toEqual(before);
  });

  it("shows current plan metadata throughout diagnostics and updates it when credentials change", async () => {
    const start = Date.parse("2026-10-14T02:00:00.000Z"), end = start + 3600000;
    await db.saveRequestUsage({ timestamp: new Date(start + 1000).toISOString(), provider: "codex", model: "test-model", connectionId: account.id, tokens: { prompt_tokens: 1, completion_tokens: 1 }, latency: { total: 1000, ttft: 100 } });
    const errors = await import("@/lib/db/repos/requestErrorsRepo.js");
    await errors.saveRequestError({ timestamp: start + 2000, provider: "codex", model: "test-model", connectionId: account.id, status: "FAILED 503", source: "upstream", message: "server_is_overloaded", pressureSignal: "overload" });
    const api = await import("@/app/api/usage/diagnostics/route.js");
    const read = () => api.GET(new Request("http://localhost/api/usage/diagnostics?" + new URLSearchParams({ start: new Date(start).toISOString(), end: new Date(end).toISOString(), accountColor: "#15803d" })));
    const report = await (await read()).json();
    expect(report.summary.recordCount).toBe(2);
    for (const row of [report.byAccount[0], report.accountPerformance.accounts[0], report.byApiKey[0].related[0], report.subjects.accounts[0], ...report.details, report.pressure.windows[0]]) expect(row.accountPlan).toMatchObject({ type: "pro", label: "Pro" });
    for (const secret of [account.idToken, "private-access", "private-refresh", "private-claim-data"]) expect(JSON.stringify(report)).not.toContain(secret);
    await db.updateProviderConnection(account.id, { idToken: token("free") });
    expect((await (await read()).json()).byAccount[0].accountPlan).toMatchObject({ type: "free", label: "免费版" });
    await db.updateProviderConnection(account.id, { idToken: "invalid", providerSpecificData: { chatgptPlanType: null } });
    expect((await (await read()).json()).byAccount[0].accountPlan.type).toBe("unknown");
    expect((await db.getProviderConnectionById(account.id)).isActive).toBe(false);
  });
});
