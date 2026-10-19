import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createTrialOutputFormatter } from "../../shared/utils/codexTrialOutput.js";

const exec = promisify(execFile);
const CLI = process.env.CODEX_TRIAL_CLI || "/opt/codex/bin/codex";
const RUNTIME = process.env.CODEX_TRIAL_RUNTIME || path.dirname(path.dirname(CLI));
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const LOG_LIMIT = 64 * 1024;

export async function getCliVersion() {
  try {
    const { stdout } = await exec(CLI, ["--version"], { timeout: 5000, maxBuffer: 4096 });
    if (process.platform === "linux") {
      try { await fs.access("/proc/self/ns/user"); }
      catch { return { available: false, version: stdout.trim(), error: "当前宿主机内核未启用用户命名空间，无法运行 Codex CLI 沙箱。请在支持用户命名空间的 Linux 主机上部署账号测试功能。" }; }
    }
    return { available: true, version: stdout.trim() };
  } catch { return { available: false, error: "容器内未找到可运行的 Codex CLI，请使用账号对比专用构建配置。" }; }
}

// A fresh CLI process and sandbox per account. No inherited user auth, MCPs, skills or config.
export async function runCodexCli({ directory, token, model, effort, prompt, signal, onProgress }) {
  const workspace = path.join(directory, "workspace");
  const home = path.join(directory, "home");
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const config = {
    model_provider: '"nine-router-trial"',
    model_reasoning_effort: JSON.stringify(effort),
    'model_providers.nine-router-trial': `{ name="9router", base_url="http://127.0.0.1:${Number(process.env.PORT) || 20128}/v1", wire_api="responses", env_key="CODEX_GATEWAY_API_KEY", request_max_retries=0, stream_max_retries=2 }`,
    approval_policy: '"never"',
    default_permissions: '"trial"',
    'permissions.trial.filesystem': `{ ":minimal"="read", ${JSON.stringify(workspace)}="write", ${JSON.stringify(home)}="read", ${JSON.stringify(RUNTIME)}="read" }`,
    'permissions.trial.network.enabled': "false",
    web_search: '"disabled"',
    'features.multi_agent': "false",
    'shell_environment_policy.inherit': '"core"',
    'shell_environment_policy.filters': '{ "CODEX_GATEWAY_API_KEY"="exclude" }',
  };
  const args = ["exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--color", "never", "-C", workspace, "-m", model];
  for (const [key, value] of Object.entries(config)) args.push("-c", `${key}=${value}`);
  args.push("-");
  const startedAt = Date.now();
  let log = "";
  let pending = "";
  let usage = null;
  let cliErrors = 0;
  let failure = "";
  let completed = false;
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
      const rendered = format(event);
      if (rendered) { appendOutput(rendered.text); activity = rendered.activity; }
    } catch { appendOutput(line); }
    publish();
  };
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
    child.stdin.end(`${prompt}\n\n请将最终作品实际写入当前工作目录的 index.html，所有 SVG、CSS 和 JavaScript 内嵌，不引用外部资源。不要运行任何测试。完成后简短说明即可。\n`);
    const { code, terminationSignal } = await exited;
    if (pending) onLine(pending);
    signal.throwIfAborted();
    if (code !== 0 || !completed || failure) throw new Error(failure || `Codex CLI 未完成（退出码 ${code ?? terminationSignal}）。${log.slice(-1600)}`);
    const file = await fs.open(path.join(workspace, "index.html"), constants.O_RDONLY | constants.O_NOFOLLOW);
    let html;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size === 0 || info.size > MAX_HTML_BYTES) throw new Error("index.html 为空、不是普通文件或超过 2 MB。" );
      html = await file.readFile("utf8");
      if (!/<(?:!doctype\s+html|html|svg|body)\b/i.test(html)) throw new Error("生成的 index.html 不包含可预览的 HTML 或 SVG。" );
    } finally { await file.close(); }
    return { ...snapshot(), html, activity: "执行完成", elapsedMs: Date.now() - startedAt };
  } catch (error) {
    const message = signal.aborted
      ? (signal.reason?.name === "TimeoutError" ? "测试超过 15 分钟，CLI 已终止。" : "测试已取消，CLI 已终止。")
      : error.code === "ENOENT" ? "Codex 未生成 index.html，或 CLI 不可用。" : error.message;
    return { ...snapshot(), error: message.replaceAll(token, "[trial-token]"), activity: "执行结束", cliErrors: Math.max(1, cliErrors), elapsedMs: Date.now() - startedAt };
  } finally {
    signal.removeEventListener("abort", stop);
    clearTimeout(killTimer);
    // Reap any remaining tool subprocesses before removing this job's private directory.
    if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } }
    await fs.rm(directory, { recursive: true, force: true });
  }
}
