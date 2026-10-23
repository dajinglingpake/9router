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
if (process.argv.includes('model_reasoning_effort="thinking"')) process.exit(2);
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
  it("keeps gateway retry errors in the existing log and output after a successful run", async () => {
    const trialSession = {};
    const promise = runCodexCli({
      directory: path.join(directory, "job"), token: "fixture-token", model: "success",
      prompt: "fixture", signal: new AbortController().signal, trialSession,
    });
    await vi.waitFor(() => expect(trialSession.logError).toBeTypeOf("function"));
    trialSession.logError("[网关自动重试 1] HTTP 503 · server_is_overloaded");
    const result = await promise;
    expect(result.error).toBeFalsy();
    expect(result.cliErrors).toBe(1);
    expect(result.log).toContain('"type":"error"');
    expect(result.output).toContain("[错误] [网关自动重试 1] HTTP 503 · server_is_overloaded");
    expect(trialSession.logError).toBeUndefined();
  });
  it("leaves provider-specific reasoning to the gateway without passing unsupported levels to the CLI", async () => {
    const result = await runCodexCli({
      directory: path.join(directory, "job"), token: "fixture-token", model: "success",
      provider: "zai", effort: "thinking", prompt: "fixture", signal: new AbortController().signal,
    });
    expect(result.error).toBeFalsy();
    expect(result.html).toBe("<html>fixture</html>");
  });
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
    if (mode === "success" || mode === "error") expect(result.html).toBe("<html>fixture</html>");
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
  it.each(["html", "symlink", "oversized", "not-html"])("preserves only valid generated HTML when stopped: %s", async kind => {
    const controller = new AbortController();
    const job = path.join(directory, "job");
    const promise = runCodexCli({ directory: job, token: "fixture-token", model: "cancel", prompt: "fixture", signal: controller.signal });
    await vi.waitFor(() => expect(fs.existsSync(path.join(directory, "child.pid"))).toBe(true));
    const artifact = path.join(job, "workspace", "index.html");
    if (kind === "symlink") {
      const outside = path.join(directory, "outside.html");
      fs.writeFileSync(outside, "<html>private</html>");
      fs.symlinkSync(outside, artifact);
    } else {
      fs.writeFileSync(artifact, kind === "html" ? "<html>unfinished preview</html>" : kind === "oversized" ? "<html>" + "x".repeat(2 * 1024 * 1024) : "not an HTML document");
    }
    controller.abort();
    const result = await promise;
    expect(result.error).toBe("测试已停止，CLI 已终止。");
    expect(result.html).toBe(kind === "html" ? "<html>unfinished preview</html>" : null);
    expect(fs.existsSync(job)).toBe(false);
  });
});

describe("Codex CLI artifact previews", () => {
  const html = "<!doctype html><html><body><svg><text>pelican</text></svg></body></html>";
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>';
  it.each([
    { name: "a differently named HTML file", files: { "pelican.html": html }, expected: html },
    { name: "a nested HTML file", files: { "animation/scene.htm": html }, expected: html },
    { name: "an SVG file", files: { "pelican.svg": svg }, expected: svg },
    { name: "an HTML code block in the reply", message: `Here is the animation:\n\`\`\`html\n${html}\n\`\`\`\nSave it to preview.`, expected: html },
    { name: "an unlabelled code block in the reply", message: `\`\`\`\n${html}\n\`\`\``, expected: html },
    { name: "an HTML block after an unrelated code block", message: `\`\`\`javascript\nconst ready = true;\n\`\`\`\n\`\`\`html\n${html}\n\`\`\``, expected: html },
    { name: "an HTML fragment in the reply", message: "```html\n<div>Animation</div>\n```", expected: "<div>Animation</div>" },
    { name: "raw HTML in the reply", message: `Here is the animation:\n${html}\nDone.`, expected: html },
    { name: "SVG in the reply", message: `\`\`\`svg\n${svg}\n\`\`\``, expected: svg },
    { name: "raw SVG in the reply", message: `Animation:\n${svg}\nDone.`, expected: svg },
    { name: "a generated file before reply content", files: { "pelican.html": html }, message: `\`\`\`svg\n${svg}\n\`\`\``, expected: html },
    { name: "index.html before other files", files: { "a.html": svg, "index.html": html }, expected: html },
    { name: "a valid file after an empty index.html", files: { "index.html": "", "pelican.html": html }, expected: html },
    { name: "reply content when no valid file was generated", files: { "index.html": "not HTML" }, message: html, expected: html },
    { name: "reply content retained after CLI failure", message: html, failed: true, expected: html },
    { name: "a missing artifact", message: "No animation was generated.", expected: null },
    { name: "HTML only in tool output", itemType: "command_execution", message: html, expected: null },
    { name: "HTML only in reasoning", itemType: "reasoning", message: html, expected: null },
    { name: "a non-HTML code block", message: `\`\`\`javascript\nconst example = '${html}';\n\`\`\``, expected: null },
    { name: "an oversized reply", message: `\`\`\`html\n<html>${"x".repeat(2 * 1024 * 1024)}</html>\n\`\`\``, expected: null },
    { name: "a linked directory outside the workspace", linkedDirectory: true, expected: null },
  ])("previews $name without appending prompt instructions", async ({ files = {}, message = "", itemType = "agent_message", failed = false, expected, linkedDirectory }) => {
    const capturedPrompt = path.join(directory, "prompt.txt");
    const outside = path.join(directory, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "private.html"), html);
    const events = [
      { type: "item.completed", item: { type: itemType, ...(itemType === "command_execution" ? { aggregated_output: message } : { text: message }) } },
      failed ? { type: "turn.failed", error: { message: "fixture failed" } } : { type: "turn.completed", usage: { output_tokens: 1 } },
    ];
    fs.writeFileSync(path.join(directory, "fixture-cli"), `#!${process.execPath}
const fs = require('fs');
const path = require('path');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(capturedPrompt)}, prompt);
  for (const [file, content] of Object.entries(${JSON.stringify(files)})) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  ${linkedDirectory ? `fs.symlinkSync(${JSON.stringify(outside)}, 'linked', 'dir');` : ""}
  for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));
  process.exitCode = ${failed ? 1 : 0};
});
`, { mode: 0o700 });
    const prompt = "创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画。\n只按这段提示词执行。";
    const job = path.join(directory, "artifact-job");
    const result = await runCodexCli({ directory: job, token: "fixture-token", model: "fixture", prompt, signal: new AbortController().signal });
    expect(fs.readFileSync(capturedPrompt, "utf8")).toBe(prompt);
    expect(result.html).toBe(expected);
    if (failed) expect(result.error).toBe("fixture failed");
    else if (expected) expect(result.error).toBeFalsy();
    else expect(result.error).toContain("未生成可预览");
    expect(fs.existsSync(job)).toBe(false);
  });
});
