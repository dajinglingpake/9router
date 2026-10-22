import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ directory: "", jobs: [], sessions: new Set(), codebuddyModels: [], codexModels: null }));
vi.mock("@/lib/dataDir", () => ({ get DATA_DIR() { return fixture.directory; } }));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: async () => [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `account-${i}`, provider: "codex", isActive: i !== 9 })),
    { id: "compatible-account", provider: "openai-compatible-fixture", isActive: false },
    { id: "claude-account", provider: "claude", isActive: true },
    { id: "codebuddy-account", provider: "codebuddy-cn", isActive: false },
  ],
  getProviderNodes: async () => [{ id: "openai-compatible-fixture", type: "openai-compatible", name: "Fixture", prefix: "fixture" }],
  getCustomModels: async () => [{ providerAlias: "fixture", id: "vendor/model", type: "llm" }],
}));
vi.mock("@/lib/codebuddyModels", () => ({
  resolveCodebuddyModels: vi.fn(async () => ({ models: fixture.codebuddyModels })),
}));
import { resolveCodebuddyModels } from "@/lib/codebuddyModels";
vi.mock("@/lib/codexModels", () => ({ resolveCodexCatalog: vi.fn(async connections => ({
  models: fixture.codexModels ?? ["gpt-6.1-sol", "gpt-5.6-terra"].map(id => ({ id, name: id, supportedEffortLevels: ["xhigh"],
    connectionIds: connections.filter(connection => connection.provider === "codex").map(connection => connection.id) })), accounts: [],
})) }));
vi.mock("@/lib/accountAppeals/history", () => ({ getAppealSummaries: async () => ({}) }));
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
  fixture.codebuddyModels = [];
  fixture.codexModels = null;
  vi.mocked(resolveCodebuddyModels).mockClear();
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
  it("starts trials only on accounts entitled to the selected live model", async () => {
    fixture.codexModels = [{ id: "gpt-6.1-sol", supportedEffortLevels: ["xhigh"], connectionIds: ["account-0"] }];
    const result = await store.startTrials(input({ ids: ["account-0", "account-1"] }));
    expect(result.count).toBe(1);
    expect(fixture.jobs.map(job => job.connectionId)).toEqual(["account-0"]);
  });
  it("rejects a model unavailable to the selected account before starting the CLI", async () => {
    fixture.codexModels = [{ id: "gpt-6.1-sol", supportedEffortLevels: ["xhigh"], connectionIds: ["account-0"] }];
    await expect(store.startTrials(input({ ids: ["account-1"] }))).rejects.toMatchObject({ status: 400 });
    expect(fixture.jobs).toHaveLength(0);
    fixture.codexModels = [];
    await expect(store.startTrials(input({ ids: ["account-0"] }))).rejects.toMatchObject({ status: 400 });
  });
  it("keeps a long-running trial alive beyond fifteen minutes until explicitly stopped", async () => {
    vi.useFakeTimers();
    // Make any native AbortSignal timeout observable under the fake clock.
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("expired", "TimeoutError")), ms);
      return controller.signal;
    });
    try {
      await store.startTrials(input({ ids: ["account-0"] }));
      const batch = globalThis.__ninerouterCodexTrials.batch;
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect((await records())[0].status).toBe("running");
      expect(fixture.jobs[0].signal.aborted).toBe(false);
      store.stopTrials();
      await batch.promise;
      expect((await records())[0].status).toBe("cancelled");
      expect(fixture.sessions.size).toBe(0);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });
  it("preserves unfinished artifacts for preview and download without marking failed runs successful", async () => {
    await store.startTrials(input({ ids: ["account-0"] }));
    const batch = globalThis.__ninerouterCodexTrials.batch;
    const html = "<html>\n<body>unfinished preview</body>\n</html>";
    fixture.jobs[0].finish({ error: "stream failed", html });
    await batch.promise;
    const record = (await records())[0];
    expect(record).toMatchObject({ status: "error", hasHtml: true, htmlLines: 3, error: "stream failed" });
    const { GET } = await import("@/app/api/codex-trials/[id]/route.js");
    const response = await GET(new Request(`http://localhost/api/codex-trials/${record.id}?format=download`), { params: Promise.resolve({ id: record.id }) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(html);
    expect(response.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    globalThis.__ninerouterCodexTrials.records.clear();
    globalThis.__ninerouterCodexTrials.loaded = false;
    expect(store.getTrialRecord(record.id)).toMatchObject({ status: "error", html, error: "stream failed" });
  });
  it("discovers CodeBuddy models on page entry without probing accounts during status polling", async () => {
    fixture.codebuddyModels = [{ id: "space-bunny", name: "Space-Bunny" }];
    const { GET } = await import("@/app/api/codex-trials/route.js");
    const response = await GET(new Request("http://localhost/api/codex-trials?refreshModels=1"));
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.providers.find(provider => provider.id === "codebuddy-cn").models.map(model => model.id)).toEqual(["space-bunny"]);
    expect(data.accounts.find(account => account.id === "codebuddy-account").enabled).toBe(false);
    expect(resolveCodebuddyModels).toHaveBeenCalledTimes(1);
    await GET(new Request("http://localhost/api/codex-trials"));
    await GET(new Request("http://localhost/api/codex-trials"));
    expect(resolveCodebuddyModels).toHaveBeenCalledTimes(1);
    expect(fixture.jobs).toHaveLength(0);
  });
  it("accepts a discovered model when starting a trial and pins it to the selected account", async () => {
    fixture.codebuddyModels = [{ id: "space-bunny", name: "Space-Bunny" }];
    await store.startTrials(input({
      ids: ["codebuddy-account"], models: [{ provider: "codebuddy-cn", model: "space-bunny" }],
    }));
    expect(fixture.jobs).toHaveLength(1);
    expect(fixture.jobs[0]).toMatchObject({
      provider: "codebuddy-cn", connectionId: "codebuddy-account", model: "space-bunny", effort: null,
    });
  });
  it("rejects models absent from discovery and retains static fallback when discovery fails", async () => {
    fixture.codebuddyModels = [{ id: "space-bunny", name: "Space-Bunny" }];
    await expect(store.startTrials(input({
      ids: ["codebuddy-account"], models: [{ provider: "codebuddy-cn", model: "unpublished-model" }],
    }))).rejects.toMatchObject({ status: 400 });
    expect(fixture.jobs).toHaveLength(0);
    fixture.codebuddyModels = [];
    const data = await store.listTrials({ discoverModels: true });
    expect(data.providers.find(provider => provider.id === "codebuddy-cn").models.some(model => model.id === "glm-5.2")).toBe(true);
    await store.startTrials(input({
      ids: ["codebuddy-account"], models: [{ provider: "codebuddy-cn", model: "glm-5.2" }],
    }));
    expect(fixture.jobs[0]).toMatchObject({ provider: "codebuddy-cn", model: "glm-5.2" });
  });
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
  it("runs a disabled compatible account alongside Codex and retains both providers' results", async () => {
    await store.startTrials(input({ ids: ["account-0"] }));
    await store.startTrials(input({ provider: "openai-compatible-fixture", all: true, models: [{ model: "vendor/model" }] }));
    expect(fixture.jobs.map(job => [job.provider, job.connectionId, job.effort])).toEqual([
      ["codex", "account-0", "xhigh"], ["openai-compatible-fixture", "compatible-account", null],
    ]);
    const batch = globalThis.__ninerouterCodexTrials.batch;
    fixture.jobs.forEach(job => job.finish());
    await batch.promise;
    expect((await records()).map(record => record.provider).sort()).toEqual(["codex", "openai-compatible-fixture"]);
    const data = await store.listTrials();
    expect(data.accounts.find(account => account.id === "compatible-account")).toMatchObject({ enabled: false, providerName: "Fixture", result: { status: "success" } });
    expect(data.providers.find(provider => provider.id === "openai-compatible-fixture").models).toEqual([{ id: "vendor/model", name: "vendor/model", efforts: [] }]);
    // The on-disk records also survive a fresh server load.
    globalThis.__ninerouterCodexTrials.records.clear();
    globalThis.__ninerouterCodexTrials.loaded = false;
    expect((await records()).filter(record => record.status === "success")).toHaveLength(2);
  });
  it("starts different providers in one submission and pins each model to its own accounts", async () => {
    const result = await store.startTrials(input({
      ids: ["account-0", "account-1", "compatible-account"], parallel: 4,
      models: [{ provider: "codex", ...models[0] }, { provider: "openai-compatible-fixture", model: models[0].model }],
    }));
    expect(result.count).toBe(3);
    expect(fixture.jobs.map(job => [job.provider, job.connectionId, job.model])).toEqual([
      ["codex", "account-0", models[0].model], ["codex", "account-1", models[0].model],
      ["openai-compatible-fixture", "compatible-account", models[0].model],
    ]);
    expect((await records()).filter(record => record.status === "running")).toHaveLength(3);
  });
  it("validates every selected provider before starting any jobs", async () => {
    await expect(store.startTrials(input({ all: true, models: [
      { provider: "codex", ...models[0] }, { provider: "unknown", model: "invalid" },
    ] }))).rejects.toMatchObject({ status: 400 });
    expect(fixture.jobs).toHaveLength(0);
    expect(await records()).toHaveLength(0);
    await expect(store.startTrials(input({ all: true, models: [models[0], models[0]] }))).rejects.toMatchObject({ status: 400 });
  });
  it("deletes only the selected finished result, persists deletion and protects running or queued jobs", async () => {
    await store.startTrials(input({ ids: ["account-0", "account-1"], parallel: 1 }));
    const [first, second] = await records();
    expect(() => store.deleteTrialRecord(first.id)).toThrow(/执行或排队/);
    expect(() => store.deleteTrialRecord(second.id)).toThrow(/执行或排队/);
    fixture.jobs[0].finish({ error: "unsupported model", html: null });
    await vi.waitFor(() => expect(fixture.jobs).toHaveLength(2));
    fixture.jobs[1].finish();
    await globalThis.__ninerouterCodexTrials.batch.promise;
    expect(store.deleteTrialRecord(first.id)).toEqual({ deleted: first.id });
    expect(store.getTrialRecord(first.id)).toBeNull();
    expect(fs.existsSync(path.join(fixture.directory, "codex-trials", `${first.id}.json`))).toBe(false);
    globalThis.__ninerouterCodexTrials.records.clear();
    globalThis.__ninerouterCodexTrials.loaded = false;
    expect((await records()).map(record => record.id)).toEqual([second.id]);
    expect(store.getTrialRecord(second.id).html).toBe("<html>saved</html>");
    expect(() => store.deleteTrialRecord(first.id)).toThrow(/不存在/);
    expect(() => store.deleteTrialRecord("../outside")).toThrow(/无效/);
  });
  it("rejects cross-provider account selections and invalid model reasoning", async () => {
    await expect(store.startTrials(input({ provider: "openai-compatible-fixture", ids: ["account-0"], models: [{ model: "vendor/model" }] }))).rejects.toMatchObject({ status: 400 });
    await expect(store.startTrials(input({ provider: "openai-compatible-fixture", all: true, models: [{ model: "vendor/model", effort: "xhigh" }] }))).rejects.toMatchObject({ status: 400 });
    await expect(store.startTrials(input({ provider: "claude", all: true }))).rejects.toMatchObject({ status: 400 });
    expect(fixture.jobs).toHaveLength(0);
  });
  it("reads legacy Codex records without replacing their saved HTML or URLs", async () => {
    fs.mkdirSync(path.join(fixture.directory, "codex-trials"), { recursive: true });
    fs.writeFileSync(path.join(fixture.directory, "codex-trials", "account-0.json"), JSON.stringify({
      id: "account-0", model: models[0].model, status: "success", html: "<html>old</html>",
    }));
    expect(store.getTrialRecord("account-0")).toMatchObject({ provider: "codex", connectionId: "account-0", html: "<html>old</html>" });
  });
});
