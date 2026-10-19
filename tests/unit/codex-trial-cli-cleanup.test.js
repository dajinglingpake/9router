import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let directory, runCodexCli;
const previousCli = process.env.CODEX_TRIAL_CLI;
const previousRuntime = process.env.CODEX_TRIAL_RUNTIME;
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cli-cleanup-"));
  const binary = path.join(directory, "fixture-cli");
  // A real process and child exercise the runner's process-group cleanup without model calls.
  fs.writeFileSync(binary, `#!${process.execPath}
const fs = require('fs');
const { spawn } = require('child_process');
const mode = process.argv[process.argv.indexOf('-m') + 1];
const child = spawn(process.execPath, ['-e', 'const memory=Buffer.alloc(32*1024*1024,1);setInterval(()=>memory[0],1000)'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(path.join(directory, "child.pid"))}, String(child.pid));
if (mode === 'cancel' || mode === 'timeout') setInterval(() => {}, 1000);
else setTimeout(() => {
  fs.writeFileSync('index.html', '<html>fixture</html>');
  const event = mode === 'success' ? {type:'turn.completed',usage:{output_tokens:1}} : {type:'turn.failed',error:{message:'fixture failed'}};
  process.stdout.write(JSON.stringify(event)+'\\n', () => process.exit(mode === 'success' ? 0 : 1));
}, 100);
`, { mode: 0o700 });
  process.env.CODEX_TRIAL_CLI = binary;
  process.env.CODEX_TRIAL_RUNTIME = directory;
  vi.resetModules();
  ({ runCodexCli } = await import("@/lib/codexTrials/cli"));
});
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
  if (previousCli === undefined) delete process.env.CODEX_TRIAL_CLI; else process.env.CODEX_TRIAL_CLI = previousCli;
  if (previousRuntime === undefined) delete process.env.CODEX_TRIAL_RUNTIME; else process.env.CODEX_TRIAL_RUNTIME = previousRuntime;
});

describe.skipIf(process.platform !== "linux")("Codex CLI resource cleanup", () => {
  it.each(["success", "error", "cancel", "timeout"])("removes job files and terminates child processes after %s", async mode => {
    const controller = new AbortController();
    const job = path.join(directory, "job");
    const promise = runCodexCli({ directory: job, token: "fixture-token", model: mode, effort: "xhigh", prompt: "fixture", signal: controller.signal });
    await vi.waitFor(() => expect(fs.existsSync(path.join(directory, "child.pid"))).toBe(true));
    const childPid = fs.readFileSync(path.join(directory, "child.pid"), "utf8");
    if (mode === "cancel") controller.abort();
    if (mode === "timeout") controller.abort(new DOMException("fixture timeout", "TimeoutError"));
    const result = await promise;
    expect(!!result.error).toBe(mode !== "success");
    if (mode === "success") expect(result.html).toBe("<html>fixture</html>");
    expect(fs.existsSync(job)).toBe(false);
    await vi.waitFor(() => {
      let status;
      try { status = fs.readFileSync(`/proc/${childPid}/status`, "utf8"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      // An exited child may briefly await init's waitpid; it has no resident memory then.
      expect(!status || /^State:\s+Z/m.test(status)).toBe(true);
      if (status) expect(status).not.toMatch(/^VmRSS:/m);
    });
  });
});
