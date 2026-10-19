import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ directory: "", jobs: [], sessions: new Set() }));
vi.mock("@/lib/dataDir", () => ({ get DATA_DIR() { return fixture.directory; } }));
vi.mock("@/lib/localDb", () => ({ getProviderConnections: async () => Array.from({ length: 10 }, (_, i) => ({ id: `account-${i}`, provider: "codex", isActive: i !== 9 })) }));
vi.mock("@/sse/local/codexTrialSession", () => ({ createTrialSession: (id, model) => {
  const token = `${id}/${model}`;
  fixture.sessions.add(token);
  return { token, session: { requests: 0, errors: 0, models: new Set() }, revoke: () => fixture.sessions.delete(token) };
} }));
vi.mock("@/lib/codexTrials/cli", () => ({
  getCliVersion: async () => ({ available: true, version: "fixture" }),
  runCodexCli: job => new Promise(resolve => {
    const finish = result => { job.signal.removeEventListener("abort", abort); resolve({ html: "<html>saved</html>", elapsedMs: 100, usage: { output_tokens: 10 }, ...result }); };
    const abort = () => finish({ error: "cancelled", html: null });
    job.signal.addEventListener("abort", abort, { once: true });
    fixture.jobs.push({ ...job, finish });
  }),
}));

let store;
const models = [{ model: "gpt-6.1-sol", effort: "xhigh" }];
const input = extra => ({ prompt: "fixture", models, ...extra });
const records = async () => (await store.listTrials()).accounts.flatMap(a => a.results);
beforeEach(async () => {
  fixture.directory = fs.mkdtempSync(path.join(os.tmpdir(), "9router-trial-queue-"));
  fixture.jobs = [];
  fixture.sessions.clear();
  delete globalThis.__ninerouterCodexTrials;
  vi.resetModules();
  store = await import("@/lib/codexTrials/store");
});
afterEach(async () => {
  const batch = globalThis.__ninerouterCodexTrials?.batch;
  store.stopTrials();
  await batch?.promise;
  fs.rmSync(fixture.directory, { recursive: true, force: true });
  delete globalThis.__ninerouterCodexTrials;
});

describe("Codex trial scheduling", () => {
  it("defaults to four parallel jobs and starts different accounts before additional models", async () => {
    await store.startTrials(input({ all: true, models: [...models, { model: "gpt-5.6-terra", effort: "xhigh" }] }));
    expect(fixture.jobs.map(j => j.connectionId)).toEqual(["account-0", "account-1", "account-2", "account-3"]);
    expect((await records()).filter(r => r.status === "queued")).toHaveLength(16);
    fixture.jobs[0].finish();
    await vi.waitFor(() => expect(fixture.jobs).toHaveLength(5));
    expect(fixture.jobs[4].connectionId).toBe("account-4");
    expect((await records()).filter(r => r.status === "running")).toHaveLength(4);
    expect((await store.listTrials()).parallel).toBe(4);
  });
  it("allows another account and another model to fill spare slots without replacing active runs", async () => {
    await store.startTrials(input({ ids: ["account-0"], parallel: 4 }));
    const original = (await records())[0];
    await store.startTrials(input({ ids: ["account-1"] }));
    await store.startTrials(input({ ids: ["account-0"], models: [{ model: "gpt-5.6-terra", effort: "xhigh" }] }));
    expect(fixture.jobs).toHaveLength(3);
    await expect(store.startTrials(input({ ids: ["account-0"] }))).rejects.toMatchObject({ status: 409 });
    expect(store.getTrialRecord(original.id).runId).toBe(original.runId);
    expect(fixture.jobs).toHaveLength(3);
    // After one model finishes it can be retested while the other two are still running.
    fixture.jobs[0].finish();
    await vi.waitFor(() => expect(store.getTrialRecord(original.id).status).toBe("success"));
    await store.startTrials(input({ ids: ["account-0"] }));
    expect(fixture.jobs).toHaveLength(4);
    expect(store.getTrialRecord(original.id)).toMatchObject({ status: "running", html: null, attempts: 2 });
  });
  it("queues additions at capacity and releases every session and worker when stopped", async () => {
    await store.startTrials(input({ ids: ["account-0", "account-1"], parallel: 1 }));
    await store.startTrials(input({ ids: ["account-2"], parallel: 10 }));
    expect(fixture.jobs).toHaveLength(1);
    expect((await store.listTrials()).parallel).toBe(1);
    const batch = globalThis.__ninerouterCodexTrials.batch;
    store.stopTrials();
    await batch.promise;
    expect(fixture.jobs).toHaveLength(1);
    expect((await records()).map(r => r.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(fixture.sessions.size).toBe(0);
    expect(batch.workers).toBe(0);
    expect(batch.queue).toHaveLength(0);
    expect(batch.sessions.size).toBe(0);
    expect(globalThis.__ninerouterCodexTrials.batch).toBeNull();
  });
  it("supports ten concurrent jobs including disabled accounts and releases resources after success and failure", async () => {
    await store.startTrials(input({ all: true, parallel: 10 }));
    expect(fixture.jobs).toHaveLength(10);
    const batch = globalThis.__ninerouterCodexTrials.batch;
    fixture.jobs.forEach((job, i) => job.finish(i === 0 ? { error: "fixture failure", html: null } : {}));
    await batch.promise;
    expect((await records()).filter(r => r.status === "success")).toHaveLength(9);
    expect((await records()).filter(r => r.status === "error")).toHaveLength(1);
    expect(fixture.sessions.size).toBe(0);
    expect(batch.sessions.size).toBe(0);
    expect(batch.workers).toBe(0);
    expect(globalThis.__ninerouterCodexTrials.batch).toBeNull();
  });
  it.each([0, 11, 1.5, "invalid"])("rejects invalid parallel limits without starting a process: %s", async parallel => {
    await expect(store.startTrials(input({ all: true, parallel }))).rejects.toMatchObject({ status: 400 });
    expect(fixture.jobs).toHaveLength(0);
  });
});
