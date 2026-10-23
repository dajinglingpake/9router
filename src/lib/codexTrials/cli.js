import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createTrialOutputFormatter } from "../../shared/utils/codexTrialOutput.js";

const exec = promisify(execFile);
const CLI = process.env.CODEX_TRIAL_CLI || "/opt/codex/bin/codex";
const RUNTIME = process.env.CODEX_TRIAL_RUNTIME || path.dirname(path.dirname(CLI));
const UNSANDBOXED = process.env.CODEX_TRIAL_UNSANDBOXED !== "false";
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const LOG_LIMIT = 64 * 1024;

const isPreviewHtml = html => typeof html === "string" && Buffer.byteLength(html, "utf8") <= MAX_HTML_BYTES
  && /<(?:!doctype\s+html|[a-z][a-z0-9:-]*)(?:\s|\/?>)/i.test(html);

function readReplyHtml(text) {
  for (const [, language, code] of text.matchAll(/```([^\r\n`]*)\r?\n([\s\S]*?)```/g)) {
    if (/^(?:html?|svg|xml)?$/i.test(language.trim()) && isPreviewHtml(code)) return code.trim();
  }
  const raw = text.replace(/```[\s\S]*?```/g, "").match(/(?:<!doctype\s+html[^>]*>\s*)?<html\b[\s\S]*<\/html\s*>|<body\b[\s\S]*<\/body\s*>|<svg\b[\s\S]*<\/svg\s*>/i)?.[0];
  return isPreviewHtml(raw) ? raw : null;
}

async function readTrialHtml(workspace, replyHtml) {
  const root = await fs.realpath(workspace);
  const directories = [root];
  const candidates = [];
  for (const directory of directories) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && !["node_modules", ".git"].includes(entry.name)) directories.push(file);
      else if (entry.isFile() && /\.(?:html?|svg)$/i.test(entry.name)) candidates.push(file);
    }
  }
  const index = path.join(root, "index.html");
  candidates.sort((a, b) => Number(b === index) - Number(a === index) || a.localeCompare(b));
  for (const candidate of candidates) {
    let file;
    try {
      if (!(await fs.realpath(candidate)).startsWith(root + path.sep)) continue;
      file = await fs.open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await file.stat();
      if (!info.isFile() || info.size === 0 || info.size > MAX_HTML_BYTES) continue;
      const html = await file.readFile("utf8");
      if (isPreviewHtml(html)) return html;
    } catch { /* Try the remaining generated files or the assistant's reply. */ }
    finally { await file?.close(); }
  }
  if (replyHtml) return replyHtml;
  throw new Error("本次测试未生成可预览的 HTML 或 SVG 文件，回复中也没有可预览内容。");
}

export async function getCliVersion() {
  try {
    const { stdout } = await exec(CLI, ["--version"], { timeout: 5000, maxBuffer: 4096 });
    if (!UNSANDBOXED && process.platform === "linux") {
      try { await fs.access("/proc/self/ns/user"); }
      catch { return { available: false, version: stdout.trim(), error: "当前宿主机内核未启用用户命名空间，无法运行 Codex CLI 沙箱。请在支持用户命名空间的 Linux 主机上部署账号测试功能。" }; }
    }
    return { available: true, version: stdout.trim() };
  } catch { return { available: false, error: "容器内未找到可运行的 Codex CLI，请使用账号对比专用构建配置。" }; }
}

// A fresh CLI process per account. No inherited user auth, MCPs, skills or config.
export async function runCodexCli({ directory, token, model, effort, provider = "codex", prompt, signal, onProgress, trialSession }) {
  const workspace = path.join(directory, "workspace");
  const home = path.join(directory, "home");
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const config = {
    model_provider: '"nine-router-trial"',
    // The gateway applies provider-specific levels (e.g. "thinking"), which the CLI cannot parse.
    ...(provider === "codex" && effort ? { model_reasoning_effort: JSON.stringify(effort) } : {}),
    'model_providers.nine-router-trial': `{ name="9router", base_url="http://127.0.0.1:${Number(process.env.PORT) || 20128}/v1", wire_api="responses", env_key="CODEX_GATEWAY_API_KEY", request_max_retries=0, stream_max_retries=2 }`,
    approval_policy: '"never"',
    ...(!UNSANDBOXED ? {
      default_permissions: '"trial"',
      'permissions.trial.filesystem': `{ ":minimal"="read", ${JSON.stringify(workspace)}="write", ${JSON.stringify(home)}="read", ${JSON.stringify(RUNTIME)}="read" }`,
      'permissions.trial.network.enabled': "false",
    } : {}),
    web_search: '"disabled"',
    'features.multi_agent': "false",
    'shell_environment_policy.inherit': '"core"',
    'shell_environment_policy.filters': '{ "CODEX_GATEWAY_API_KEY"="exclude" }',
  };
  const args = ["exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--color", "never", "-C", workspace, "-m", model];
  if (UNSANDBOXED) args.push("--dangerously-bypass-approvals-and-sandbox");
  for (const [key, value] of Object.entries(config)) args.push("-c", `${key}=${value}`);
  args.push("-");
  const startedAt = Date.now();
  let log = "";
  let pending = "";
  let usage = null;
  let cliErrors = 0;
  let failure = "";
  let completed = false;
  let replyHtml = null;
  let output = "";
  let activity = "正在启动 Codex CLI";
  let lastOutputAt = null;
  const format = createTrialOutputFormatter();
  const snapshot = () => ({ log, output, activity, lastOutputAt, cliErrors, usage });
  const publish = () => onProgress?.(snapshot());
  const appendOutput = text => { if (text) output = (output + text.replaceAll(token, "[trial-token]") + "\n\n").slice(-LOG_LIMIT); };
  const appendLog = text => { log = (log + text.replaceAll(token, "[trial-token]")).slice(-LOG_LIMIT); };
  const onLine = line => {
    if (!line.trim()) return;
    appendLog(line + "\n");
    lastOutputAt = new Date().toISOString();
    try {
      const event = JSON.parse(line);
      if (event.type === "turn.completed") { usage = event.usage || null; completed = true; }
      if (event.type === "error") cliErrors++;
      if (event.type === "turn.failed") failure = event.error?.message || "Codex 执行失败。";
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        replyHtml = readReplyHtml(event.item.text || "") || replyHtml;
      }
      const rendered = format(event);
      if (rendered) { appendOutput(rendered.text); activity = rendered.activity; }
    } catch { appendOutput(line); }
    publish();
  };
  if (trialSession) trialSession.logError = message => onLine(JSON.stringify({ type: "error", message }));
  let killTimer;
  let child;
  const stop = () => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ }
    killTimer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } }, 5000);
    killTimer.unref();
  };
  try {
    signal.throwIfAborted();
    child = spawn(CLI, args, {
      cwd: workspace, detached: true, stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: `${path.dirname(CLI)}:/usr/local/bin:/usr/bin:/bin`,
        HOME: home, CODEX_HOME: home, LANG: "C.UTF-8",
        CODEX_GATEWAY_API_KEY: token,
      },
    });
    child.once("spawn", () => { activity = "CLI 已启动，等待输出"; publish(); });
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        onLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      if (pending.length > 4 * 1024 * 1024) { failure = "Codex 单条输出超过大小限制。"; stop(); }
    });
    child.stderr.on("data", chunk => {
      appendLog(chunk); appendOutput(chunk);
      lastOutputAt = new Date().toISOString();
      activity = "收到 CLI 诊断输出";
      publish();
    });
    // EPIPE is expected if validation rejects the CLI configuration before stdin is read.
    child.stdin.on("error", () => {});
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, terminationSignal) => resolve({ code, terminationSignal }));
    });
    child.stdin.end(prompt);
    const { code, terminationSignal } = await exited;
    if (pending) onLine(pending);
    signal.throwIfAborted();
    if (code !== 0 || !completed || failure) throw new Error(failure || `Codex CLI 未完成（退出码 ${code ?? terminationSignal}）。${log.slice(-1600)}`);
    const html = await readTrialHtml(workspace, replyHtml);
    return { ...snapshot(), html, activity: "执行完成", elapsedMs: Date.now() - startedAt };
  } catch (error) {
    const message = signal.aborted
      ? "测试已停止，CLI 已终止。"
      : error.code === "ENOENT" ? "Codex CLI 不可用。" : error.message;
    // Stop remaining writers before preserving the latest artifact and removing the private workspace.
    if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } }
    const html = await readTrialHtml(workspace, replyHtml).catch(() => null);
    return { ...snapshot(), html, error: message.replaceAll(token, "[trial-token]"), activity: html ? "执行结束，已保留未完成作品" : "执行结束", cliErrors: Math.max(1, cliErrors), elapsedMs: Date.now() - startedAt };
  } finally {
    if (trialSession) delete trialSession.logError;
    signal.removeEventListener("abort", stop);
    clearTimeout(killTimer);
    // Reap any remaining tool subprocesses before removing this job's private directory.
    if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } }
    await fs.rm(directory, { recursive: true, force: true });
  }
}
