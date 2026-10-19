import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const HELP_URL = "https://help.openai.com/zh-hans-cn/collections/3742473-chatgpt?chat=true";
export const VIEWPORT = { width: 1280, height: 900 };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// This function runs only inside the isolated Help Center page. Keep it self-contained.
export async function applyHelpIdentity(user) {
  if (location.hostname !== "help.openai.com") return { ready: false };
  if (window.__nineRouterAppealAccount === user.id) return { ready: true };
  let context;
  for (const node of [document.body, ...document.querySelectorAll("body > *")].filter(Boolean)) {
    const key = Object.keys(node).find(name => name.startsWith("__reactFiber"));
    for (let fiber = key && node[key]; fiber; fiber = fiber.return) {
      const value = fiber.memoizedProps?.value;
      if (typeof value?.setGlobalContextOverride === "function") { context = value; break; }
    }
    if (context) break;
  }
  if (!context) return { ready: false };
  const response = await fetch("https://support.api.openai.com/api/v1/me", {
    headers: { Authorization: `Bearer ${user.accessToken}` }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) return { error: response.status === 401 ? "账号授权已失效，请重新授权后再打开申诉。" : "客服身份验证失败，请重试。" };
  const me = await response.json();
  if (me.user_id !== user.id || me.email?.toLowerCase() !== user.email.toLowerCase()) return { error: "客服身份与所选账号不一致，已停止登录。" };
  // Fresh profiles are used for every session; no daily-browser storage is touched.
  localStorage.removeItem("oaisae-active-thread-id");
  sessionStorage.removeItem("oaisae-active-thread-id");
  context.setGlobalContextOverride({ user: { id: me.user_id, email: me.email, name: me.name, accessToken: user.accessToken } });
  window.__nineRouterAppealAccount = user.id;
  return { ready: true };
}

export async function launchAppealBrowser({ proxyUrl, onExit = () => {} } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "9router-appeal-"));
  const binary = process.env.ACCOUNT_APPEAL_CHROMIUM || "/usr/bin/chromium";
  const args = ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-sync", "--disable-extensions", "--disable-features=Translate", "--remote-debugging-pipe", `--user-data-dir=${directory}`, `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, "--lang=zh-CN", "about:blank"];
  let proxy;
  if (proxyUrl) {
    proxy = new URL(proxyUrl);
    if (!["http:", "https:", "socks5:"].includes(proxy.protocol)) { await fs.rm(directory, { recursive: true, force: true }); throw new Error("申诉浏览器暂不支持此代理类型。"); }
    if (proxy.protocol === "socks5:" && (proxy.username || proxy.password)) { await fs.rm(directory, { recursive: true, force: true }); throw new Error("申诉浏览器暂不支持带密码的 SOCKS 代理，请使用 HTTP 代理。"); }
    args.push(`--proxy-server=${proxy.protocol}//${proxy.host}`, "--proxy-bypass-list=<-loopback>");
  }
  let child, stopped = false, nextId = 0, sessionId, pending = Buffer.alloc(0);
  const requests = new Map();
  const failPending = () => { for (const task of requests.values()) { clearTimeout(task.timer); task.reject(new Error("申诉浏览器已关闭。")); } requests.clear(); };
  const send = (method, params = {}, target = sessionId) => new Promise((resolve, reject) => {
    if (stopped || !child?.stdio[3]?.writable) return reject(new Error("申诉浏览器已关闭。"));
    const id = ++nextId;
    const timer = setTimeout(() => { requests.delete(id); reject(new Error("申诉浏览器响应超时。")); }, 20000);
    timer.unref();
    requests.set(id, { resolve, reject, timer });
    child.stdio[3].write(JSON.stringify({ id, method, params, ...(target ? { sessionId: target } : {}) }) + "\0");
  });
  const close = async () => {
    if (stopped) return;
    stopped = true;
    failPending();
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ }
      await Promise.race([new Promise(resolve => child.once("close", resolve)), pause(1000)]);
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
      // Give the container init process time to reap grandchildren after group termination.
      for (let attempt = 0; attempt < 20; attempt++) {
        try { process.kill(-child.pid, 0); } catch { break; }
        await pause(50);
      }
    }
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  };
  try {
    child = spawn(binary, args, { detached: true, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: directory, LANG: "zh_CN.UTF-8" } });
    child.stdio[3].on("error", failPending);
    child.once("error", failPending);
    child.once("close", () => { failPending(); onExit(); });
    child.stdio[4].on("data", chunk => {
      pending = Buffer.concat([pending, chunk]);
      let end;
      while ((end = pending.indexOf(0)) >= 0) {
        const line = pending.subarray(0, end).toString(); pending = pending.subarray(end + 1);
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.id) {
          const task = requests.get(event.id);
          if (!task) continue;
          clearTimeout(task.timer); requests.delete(event.id);
          if (event.error) task.reject(new Error("申诉浏览器操作失败。")); else task.resolve(event.result);
        } else if (event.method === "Fetch.requestPaused") {
          send("Fetch.continueRequest", { requestId: event.params.requestId }, event.sessionId).catch(() => {});
        } else if (event.method === "Fetch.authRequired") {
          const authentication = event.params.authChallenge.source === "Proxy" && proxy
            ? { response: "ProvideCredentials", username: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) }
            : { response: "CancelAuth" };
          send("Fetch.continueWithAuth", { requestId: event.params.requestId, authChallengeResponse: authentication }, event.sessionId).catch(() => {});
        }
      }
      if (pending.length > 16 * 1024 * 1024) close().catch(() => {});
    });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const targets = await send("Target.getTargets", {}, null);
    const targetId = targets.targetInfos.find(target => target.type === "page")?.targetId
      || (await send("Target.createTarget", { url: "about:blank" }, null)).targetId;
    sessionId = (await send("Target.attachToTarget", { targetId, flatten: true }, null)).sessionId;
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
    if (proxy?.username || proxy?.password) await send("Fetch.enable", { handleAuthRequests: true });
    const evaluate = async expression => {
      const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) throw new Error("帮助中心页面尚未就绪，请稍后重试。");
      return response.result.value;
    };
    return {
      pid: child.pid, close, send, evaluate,
      navigate: () => send("Page.navigate", { url: HELP_URL }),
      screenshot: async () => (await send("Page.captureScreenshot", { format: "jpeg", quality: 65, captureBeyondViewport: false })).data,
      authenticate: user => evaluate(`(${applyHelpIdentity.toString()})(${JSON.stringify(user)})`),
    };
  } catch (error) {
    await close();
    if (error.code === "ENOENT") throw new Error("容器中尚未安装申诉浏览器，请使用包含申诉功能的镜像。");
    throw error;
  }
}
