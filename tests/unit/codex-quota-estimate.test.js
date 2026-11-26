import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_QUOTA_WINDOW_SECONDS as periods } from "open-sse/config/local/codexQuotaWindows.js";
import { estimateCodexQuota } from "@/lib/local/codexQuotaEstimate.js";
import { buildCodexQuotaSummary } from "@/lib/local/codexQuotaSummary.js";

const loadUsage = vi.hoisted(() => vi.fn());
vi.mock("@/lib/providerUsage.js", () => ({ loadConnectionUsage: loadUsage }));

const start = Date.parse("2026-11-26T00:00:00Z");
const iso = offset => new Date(start + offset).toISOString();
const quota = (name, remaining, resetAt = iso(periods[name] * 1000)) => ({
  total: 100, used: 100 - remaining, windowSeconds: periods[name], resetAt,
});
const upstream = (session, weekly) => ({
  plan: "plus", quotas: { session: quota("session", session), weekly: quota("weekly", weekly) },
});
const log = (offset, remaining, cost, { resetAt, plan = "plus", sharedWith, model = "gpt-5.6-sol" } = {}) => ({
  connectionId: "a", model, cost,
  codexQuota: {
    sampledAt: iso(offset), plan, windows: {
      weekly: { remainingPercent: remaining, windowSeconds: periods.weekly, resetAt: resetAt || iso(periods.weekly * 1000), sharedWith },
    },
  },
});

describe("Codex quota estimate", () => {
  const plans = new Map([["a", "plus"]]);
  it("sums one batch once, includes flat readings and ignores separate quota families", () => {
    const rows = [
      log(0, 100, 500),
      log(10, 100, 1),
      log(15, 99, 100, { model: "gpt-5.6-sol-review" }),
      log(20, 95, 2),
      log(20, 95, 1),
      log(30, 85, 6),
    ];
    expect(estimateCodexQuota(rows, plans).get("a")).toEqual({ session: null, weekly: 10 / 0.15 });
  });

  it("breaks intervals at resets, plan changes, missing samples, and unpriced usage", () => {
    const resetAt = iso(periods.weekly * 1000 + 1000);
    const rows = [
      log(0, 100, 1),
      log(10, 96, 1),
      log(20, 80, 100, { resetAt }),
      log(30, 75, 0, { resetAt }),
      { ...log(40, 70, 100, { resetAt }), codexQuota: null },
      log(50, 70, 100, { resetAt }),
      log(60, 60, 100, { resetAt, plan: "pro" }),
      log(70, 55, 100, { resetAt }),
      log(80, 50, 2, { resetAt }),
      log(90, 0, 100, { resetAt }),
    ];
    expect(estimateCodexQuota(rows, plans).get("a")).toEqual({ session: null, weekly: 40 });
  });

  it("reports partial dollar coverage and excludes weekly aliases from the 5h calculation", () => {
    const a = { id: "a", provider: "codex", authType: "oauth", isActive: true };
    const b = { ...a, id: "b" };
    const aUsage = upstream(80, 95);
    const bWeekly = quota("weekly", 100);
    const bUsage = { plan: "plus", quotas: { session: { ...bWeekly, sharedWith: "weekly" }, weekly: bWeekly } };
    const snapshots = new Map([["a", aUsage], ["b", bUsage]]);
    const estimates = new Map([["a", { session: 20, weekly: 40 }]]);
    const { groups: [group] } = buildCodexQuotaSummary([a, b], snapshots, start, estimates);
    expect(group.session.dollars).toMatchObject({ accountCount: 1, estimatedAccounts: 1, fullUsd: 20, remainingUsd: 16 });
    expect(group.weekly.dollars).toMatchObject({ accountCount: 2, estimatedAccounts: 1, fullUsd: 40, remainingUsd: 38 });
  });
});

describe("Codex quota usage logging", () => {
  let tempDir;
  let db;
  let connection;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    loadUsage.mockReset();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-quota-estimate-"));
    vi.stubEnv("DATA_DIR", tempDir);
    delete global._dbAdapter;
    db = await import("@/lib/db/index.js");
    await db.initDb();
    connection = await db.createProviderConnection({
      provider: "codex", authType: "oauth", name: "Codex fixture", accessToken: "test-token",
    });
  });

  afterEach(() => {
    global._dbAdapter?.instance?.close?.();
    delete global._dbAdapter;
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("persists both percentages alongside request cost and renders the estimates in the summary", async () => {
    const request = {
      provider: "codex", model: "gpt-5.6-sol", connectionId: connection.id,
      tokens: { prompt_tokens: 100_000, completion_tokens: 10_000 },
      latency: { total: 123 },
    };
    loadUsage.mockResolvedValueOnce(upstream(98, 99)).mockResolvedValue(upstream(88, 94));
    await db.saveRequestUsage({ ...request });
    vi.setSystemTime(start + 60_000);
    await db.saveRequestUsage({ ...request });

    const { getCodexQuotaUsageRows } = await import("@/lib/db/repos/usageRepo.js");
    const rows = await getCodexQuotaUsageRows([connection.id], start);
    expect(rows).toHaveLength(2);
    expect(rows[1].codexQuota.windows).toMatchObject({
      session: { remainingPercent: 88, windowSeconds: periods.session },
      weekly: { remainingPercent: 94, windowSeconds: periods.weekly },
    });
    expect(rows[1].cost).toBeGreaterThan(0);
    expect((await db.getRecentLogs())[0]).toContain("5h 88.0% · 7d 94.0%");
    expect((await db.getUsageHistory())[1].latency).toEqual({ total: 123 });

    const { loadCodexQuotaSummary } = await import("@/lib/local/loadCodexQuotaSummary.js");
    const { groups: [group] } = await loadCodexQuotaSummary({ force: true, includeEstimates: true });
    expect(group.session.dollars.fullUsd).toBeCloseTo(rows[1].cost / 0.10);
    expect(group.session.dollars.remainingUsd).toBeCloseTo(rows[1].cost / 0.10 * 0.88);
    expect(group.weekly.dollars.fullUsd).toBeCloseTo(rows[1].cost / 0.05);
    expect(group.weekly.dollars.remainingUsd).toBeCloseTo(rows[1].cost / 0.05 * 0.94);
  });

  it("gives completions during an in-flight read a fresh, shared sample", async () => {
    const { sampleCodexQuota } = await import("@/lib/local/sampleCodexQuota.js");
    let release;
    loadUsage.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    loadUsage.mockResolvedValue(upstream(85, 96));
    const first = sampleCodexQuota(connection.id);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const second = sampleCodexQuota(connection.id);
    expect(sampleCodexQuota(connection.id)).toBe(second);
    release(upstream(90, 97));
    expect((await first).windows.session.remainingPercent).toBe(90);
    expect((await second).windows.session.remainingPercent).toBe(85);
    expect(loadUsage).toHaveBeenCalledTimes(2);
  });
});
