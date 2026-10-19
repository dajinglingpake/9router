import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DATA_DIR } from "@/lib/dataDir";
import { getProviderConnections } from "@/lib/localDb";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { CODEX_TRIAL_MODELS, CODEX_TRIAL_PROMPT_LIMIT, countTrialHtmlLines } from "@/shared/utils/codexTrial";
import { getOutputThroughput } from "@/shared/utils/outputThroughput";
import { getAccountQualityMetadata } from "@/shared/utils/accountQuality.js";
import { createTrialSession } from "@/sse/local/codexTrialSession";
import { getCliVersion, runCodexCli } from "./cli";

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
  const connections = await getProviderConnections({ provider: "codex" });
  if (!state.cli) state.cli = await getCliVersion();
  return {
    cli: state.cli,
    running: !!state.batch,
    accounts: connections.map(connection => {
      const results = [...state.records.values()].filter(record => record.connectionId === connection.id)
        .sort((a, b) => a.model.localeCompare(b.model)).map(record => {
          const { html, log, output, prompt, ...summary } = record;
          const session = state.batch?.sessions.get(record.id);
          return { ...summary, hasHtml: !!html, outputTail: active(record) ? output?.slice(-12000) || "" : undefined,
            requests: session?.requests ?? record.requests, routerErrors: session?.errors ?? record.routerErrors };
        });
      return {
        id: connection.id, name: connection.displayName || connection.name || connection.email || connection.id,
        email: connection.email || "", enabled: connection.isActive !== false,
        ...getAccountQualityMetadata(connection),
        results, result: results[0] || null,
      };
    }),
  };
}

export async function startTrials(input) {
  initialize();
  if (state.batch) throw fail("已有测试正在执行，请等待完成或先停止。", 409);
  if (!input || typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > CODEX_TRIAL_PROMPT_LIMIT) throw fail(`请输入 1–${CODEX_TRIAL_PROMPT_LIMIT} 字的提示词。`);
  const models = input.models ?? [{ model: input.model, effort: input.effort }];
  if (!Array.isArray(models) || !models.length || models.length > CODEX_TRIAL_MODELS.length
    || models.some(item => !item || !CODEX_TRIAL_MODELS.some(model => model.id === item.model)
      || !getThinkingLevels("codex", item.model)?.includes(item.effort))) throw fail("请选择有效的模型和推理强度。");
  if (new Set(models.map(item => item.model)).size !== models.length) throw fail("请勿重复选择同一模型。");
  const parallel = Number(input.parallel ?? 2);
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 3) throw fail("并行数必须为 1–3。");
  const connections = await getProviderConnections({ provider: "codex" });
  const ids = input.all === true ? connections.map(connection => connection.id) : [...new Set(Array.isArray(input.ids) ? input.ids : [])];
  if (!ids.length || ids.some(id => !connections.some(connection => connection.id === id))) throw fail("请选择有效的 Codex 账号。");
  state.cli = await getCliVersion();
  if (!state.cli.available) throw fail(state.cli.error, 503);
  // Re-check after asynchronous validation so two tabs cannot start overlapping batches.
  if (state.batch) throw fail("已有测试正在执行。", 409);
  const batch = { controller: new AbortController(), sessions: new Map(), ids: [] };
  state.batch = batch;
  try {
    for (const connectionId of ids) for (const { model, effort } of models) {
      const previous = [...state.records.values()].find(record => record.connectionId === connectionId && record.model === model);
      // Keep legacy artifact URLs; new account/model pairs have independent persistent records.
      const id = previous?.id || createHash("sha256").update(JSON.stringify([connectionId, model])).digest("hex");
      save({
        id, connectionId, runId: randomUUID(), status: "queued", prompt: input.prompt.trim(), model, effort,
        cliVersion: state.cli.version, queuedAt: new Date().toISOString(), startedAt: null, finishedAt: null,
        attempts: (previous?.attempts || 0) + 1, failures: previous?.failures || 0,
        html: null, htmlLines: 0, log: "", output: "", activity: "等待测试位置", lastOutputAt: null, error: null, usage: null, elapsedMs: null, tokensPerSecond: null,
        routerErrors: 0, routerStatsVersion: 3, cliErrors: 0, requests: 0, reportedModels: [],
      });
      batch.ids.push(id);
    }
  } catch (error) { state.batch = null; throw error; }
  const queue = [...batch.ids];
  async function worker() {
    while (queue.length) {
      const id = queue.shift();
      const record = state.records.get(id);
      if (batch.controller.signal.aborted) {
        save({ ...record, status: "cancelled", error: "已取消排队。", finishedAt: new Date().toISOString() });
        continue;
      }
      const session = createTrialSession(record.connectionId, record.model, record.effort);
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
  }
  // The task belongs to the server, not the browser connection; refreshes do not cancel it.
  batch.promise = Promise.allSettled(Array.from({ length: Math.min(parallel, batch.ids.length) }, worker)).then(results => {
    for (const result of results) if (result.status === "rejected") console.error("[Codex trials]", result.reason?.message);
  }).finally(() => { if (state.batch === batch) state.batch = null; });
  return { count: batch.ids.length };
}

export function stopTrials() {
  state.batch?.controller.abort();
  return { stopping: !!state.batch };
}
