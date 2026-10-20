import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DATA_DIR } from "@/lib/dataDir";
import { getProviderConnections } from "@/lib/localDb";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { CODEX_TRIAL_PROMPT_LIMIT, CODEX_TRIAL_PARALLEL, CODEX_TRIAL_MAX_PARALLEL, countTrialHtmlLines } from "@/shared/utils/codexTrial";
import { getOutputThroughput } from "@/shared/utils/outputThroughput";
import { getAccountQualityMetadata } from "@/shared/utils/accountQuality.js";
import { getAppealSummaries } from "@/lib/accountAppeals/history";
import { createTrialSession } from "@/sse/local/codexTrialSession";
import { getCliVersion, runCodexCli } from "./cli";
import { getTrialProviders } from "./catalog";

const ROOT = path.join(DATA_DIR, "codex-trials");
const state = globalThis.__ninerouterCodexTrials ||= { records: new Map(), loaded: false, batch: null, cli: null };
const active = record => ["queued", "running"].includes(record?.status);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const fileFor = id => {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw fail("测试记录 ID 无效。");
  return path.join(ROOT, `${id}.json`);
};

function save(record) {
  const file = fileFor(record.id);
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(temp, file);
  state.records.set(record.id, record);
}

function initialize() {
  if (state.loaded) return;
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(ROOT).filter(name => /^[a-zA-Z0-9_-]+\.json$/.test(name))) {
    const record = JSON.parse(fs.readFileSync(path.join(ROOT, name), "utf8"));
    record.connectionId ||= record.id;
    record.provider ||= "codex";
    record.htmlLines = countTrialHtmlLines(record.html || "");
    if (active(record)) {
      Object.assign(record, { status: "interrupted", error: "服务已重启，本次测试中断，请重新测试。", html: null, finishedAt: new Date().toISOString() });
      save(record);
    } else state.records.set(record.id, record);
  }
  state.loaded = true;
}

export function getTrialRecord(id) {
  initialize();
  fileFor(id);
  return state.records.get(id) || null;
}

export async function listTrials() {
  initialize();
  const connections = await getProviderConnections();
  const providers = await getTrialProviders(connections);
  const appeals = await getAppealSummaries();
  if (!state.cli) state.cli = await getCliVersion();
  return {
    serverNow: Date.now(),
    cli: state.cli,
    running: !!state.batch,
    stopping: state.batch?.controller.signal.aborted || false,
    parallel: state.batch?.parallel ?? null,
    providers,
    accounts: connections.filter(connection => providers.some(provider => provider.id === connection.provider)).map(connection => {
      const results = [...state.records.values()].filter(record => record.connectionId === connection.id)
        .sort((a, b) => a.model.localeCompare(b.model)).map(record => {
          const { html, log, output, prompt, ...summary } = record;
          const session = state.batch?.sessions.get(record.id);
          return { ...summary, hasHtml: !!html, outputTail: active(record) ? output?.slice(-12000) || "" : undefined,
            requests: session?.requests ?? record.requests, routerErrors: session?.errors ?? record.routerErrors };
        });
      return {
        id: connection.id, name: connection.displayName || connection.name || connection.email || connection.id,
        provider: connection.provider, providerName: providers.find(provider => provider.id === connection.provider).name,
        email: connection.email || "", enabled: connection.isActive !== false,
        ...getAccountQualityMetadata(connection),
        appealHistory: connection.provider === "codex" ? appeals[connection.id] || null : null,
        results, result: results[0] || null,
      };
    }),
  };
}

export async function startTrials(input) {
  initialize();
  if (!input || typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > CODEX_TRIAL_PROMPT_LIMIT) throw fail(`请输入 1–${CODEX_TRIAL_PROMPT_LIMIT} 字的提示词。`);
  const provider = input.provider ?? "codex";
  const connections = (await getProviderConnections()).filter(connection => connection.provider === provider);
  const catalog = (await getTrialProviders(connections)).find(item => item.id === provider);
  if (!catalog) throw fail("请选择已配置账号的文本模型供应商。");
  const selected = input.models ?? [{ model: input.model, effort: input.effort }];
  if (!Array.isArray(selected) || !selected.length || selected.length > 20
    || selected.some(item => !item || typeof item.model !== "string" || !/^[^\s()[\]\x00-\x1f\x7f]{1,256}$/.test(item.model)
      || (!catalog.allowCustomModel && !catalog.models.some(model => model.id === item.model))
      || (item.effort && !getThinkingLevels(provider, item.model)?.includes(item.effort)))) throw fail("请选择有效的文本模型和推理强度。");
  const models = selected.map(item => ({ model: item.model, effort: item.effort || null }));
  if (new Set(models.map(item => item.model)).size !== models.length) throw fail("请勿重复选择同一模型。");
  const parallel = Number(input.parallel ?? CODEX_TRIAL_PARALLEL);
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > CODEX_TRIAL_MAX_PARALLEL) throw fail(`并发数必须为 1–${CODEX_TRIAL_MAX_PARALLEL}。`);
  const ids = input.all === true ? connections.map(connection => connection.id) : [...new Set(Array.isArray(input.ids) ? input.ids : [])];
  if (!ids.length || ids.some(id => !connections.some(connection => connection.id === id))) throw fail("请选择属于该供应商的有效账号。");
  state.cli = await getCliVersion();
  if (!state.cli.available) throw fail(state.cli.error, 503);
  // Check each account/model after asynchronous validation so two tabs cannot overwrite an active run.
  if (state.batch?.controller.signal.aborted) throw fail("正在停止测试，请稍后再试。", 409);
  const jobs = models.flatMap(({ model, effort }) => ids.map(connectionId => {
    const previous = [...state.records.values()].find(record => record.connectionId === connectionId && record.model === model);
    if (active(previous)) throw fail("该账号的此模型已在测试或排队，请等待完成。", 409);
    return { connectionId, model, effort, previous };
  }));
  const batch = state.batch || { controller: new AbortController(), sessions: new Map(), queue: [], workers: 0, parallel };
  if (!batch.promise) batch.promise = new Promise(resolve => { batch.resolve = resolve; });
  state.batch = batch;
  try {
    // Start different accounts first, before their additional models compete for account limits.
    for (const { connectionId, model, effort, previous } of jobs) {
      // Keep legacy artifact URLs; new account/model pairs have independent persistent records.
      const id = previous?.id || createHash("sha256").update(JSON.stringify([connectionId, model])).digest("hex");
      save({
        id, connectionId, provider, runId: randomUUID(), status: "queued", prompt: input.prompt.trim(), model, effort,
        cliVersion: state.cli.version, queuedAt: new Date().toISOString(), startedAt: null, finishedAt: null,
        attempts: (previous?.attempts || 0) + 1, failures: previous?.failures || 0,
        html: null, htmlLines: 0, log: "", output: "", activity: "等待测试位置", lastOutputAt: null, error: null, usage: null, elapsedMs: null, tokensPerSecond: null,
        routerErrors: 0, routerStatsVersion: 3, cliErrors: 0, requests: 0, reportedModels: [],
      });
      batch.queue.push(id);
    }
  } finally { startWorkers(batch); }
  return { count: jobs.length, parallel: batch.parallel };
}

function startWorkers(batch) {
  // Newly submitted tests can fill spare slots in the same pool immediately.
  while (batch.workers < batch.parallel && batch.queue.length) {
    batch.workers++;
    runTrial(batch, batch.queue.shift()).catch(error => {
      console.error("[Codex trials]", error.message);
    }).finally(() => { batch.workers--; startWorkers(batch); });
  }
  if (!batch.workers && !batch.queue.length) {
    if (state.batch === batch) state.batch = null;
    batch.resolve();
  }
}

async function runTrial(batch, id) {
  const record = state.records.get(id);
  if (batch.controller.signal.aborted) {
    save({ ...record, status: "cancelled", error: "已取消排队。", finishedAt: new Date().toISOString() });
    return;
  }
  const session = createTrialSession(record.connectionId, record.model, record.effort, record.provider);
  batch.sessions.set(id, session.session);
  let progressTimer;
  const onProgress = progress => {
    const current = state.records.get(id);
    if (current?.runId !== record.runId || current.status !== "running") return;
    state.records.set(id, { ...current, ...progress });
    // Keep live reads immediate, but checkpoint at most once per second.
    if (!progressTimer) progressTimer = setTimeout(() => {
      progressTimer = null;
      try { save(state.records.get(id)); }
      catch (error) { console.error("[Codex trials] Cannot save live output:", error.message); }
    }, 1000);
  };
  try {
    save({ ...record, status: "running", activity: "正在启动 Codex CLI", startedAt: new Date().toISOString() });
    const result = await runCodexCli({
      ...record, token: session.token,
      directory: path.join(ROOT, "jobs", record.runId),
      signal: AbortSignal.any([batch.controller.signal, AbortSignal.timeout(15 * 60_000)]),
      onProgress,
    });
    clearTimeout(progressTimer);
    const status = batch.controller.signal.aborted ? "cancelled" : result.error ? "error" : "success";
    const rate = getOutputThroughput({ kind: status, outputTokens: result.usage?.output_tokens, latencyMs: result.elapsedMs });
    save({
      ...state.records.get(id), ...result, html: status === "success" ? result.html : null,
      htmlLines: status === "success" ? countTrialHtmlLines(result.html) : 0,
      status, error: result.error || null, finishedAt: new Date().toISOString(), tokensPerSecond: rate?.totalTps ?? null,
      failures: record.failures + (status === "error" ? 1 : 0),
      routerErrors: session.session.errors, requests: session.session.requests, reportedModels: [...session.session.models],
    });
  } catch (error) {
    save({ ...state.records.get(id), html: null, status: "error", error: error.message, failures: record.failures + 1, finishedAt: new Date().toISOString() });
  } finally { clearTimeout(progressTimer); session.revoke(); batch.sessions.delete(id); }
}

export function stopTrials() {
  state.batch?.controller.abort();
  return { stopping: !!state.batch };
}
