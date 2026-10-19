import { createHash, randomUUID } from "node:crypto";
import { getProviderConnectionById, getSettings } from "@/lib/localDb";
import { refreshAndUpdateCredentials } from "@/lib/providerUsage";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { ensureOutboundProxyInitialized } from "@/lib/network/initOutboundProxy";
import { launchAppealBrowser, VIEWPORT } from "./browser.mjs";

export const IDLE_MS = 15 * 60_000;
export const DISCONNECTED_MS = 60_000;
const MAX_BROWSERS = 2;
const state = globalThis.__nineRouterAccountAppeals ||= { sessions: new Map(), timer: null };
export const appealError = (message, status = 400) => Object.assign(new Error(message), { status, public: true });
export const ownerFor = token => createHash("sha256").update(token).digest("hex");
export const shouldExpire = (session, now) => now - session.lastSeen > DISCONNECTED_MS || now - session.lastInput > IDLE_MS;

async function close(session, message = "申诉窗口已关闭。") {
  if (session.closing) return session.closing;
  session.status = "closed"; session.message = message; session.user = null;
  session.closing = (async () => { await session.starting; await session.browser?.close(); session.browser = null; })();
  return session.closing;
}

function initialize() {
  if (state.timer) return;
  state.timer = setInterval(() => {
    for (const [id, session] of state.sessions) if (shouldExpire(session, Date.now())) {
      state.sessions.delete(id);
      close(session, "申诉窗口已自动关闭，浏览器资源已释放。").catch(() => {});
    }
  }, 10000);
  state.timer.unref();
  process.once("exit", () => { for (const session of state.sessions.values()) if (session.browser?.pid) { try { process.kill(-session.browser.pid, "SIGKILL"); } catch { /* Already exited. */ } } });
}

function lookup(id, owner) {
  const session = state.sessions.get(id);
  if (!session || session.owner !== owner) throw appealError("申诉窗口已结束，请重新打开。", 404);
  session.lastSeen = Date.now();
  return session;
}

async function prepare(session, connection) {
  try {
    await ensureOutboundProxyInitialized();
    const config = await resolveConnectionProxyConfig(connection.providerSpecificData);
    if (config.vercelRelayUrl) throw appealError("申诉浏览器需要 HTTP 或 SOCKS 代理，暂不支持此账号的网页中继代理。", 400);
    const settings = await getSettings();
    const proxyUrl = config.connectionProxyEnabled ? config.connectionProxyUrl : settings.outboundProxyEnabled ? settings.outboundProxyUrl : null;
    if (config.strictProxy && !proxyUrl) throw appealError("此账号要求使用代理，但没有可用代理。", 400);
    const proxyOptions = { ...config, ...(proxyUrl ? { connectionProxyEnabled: true, connectionProxyUrl: proxyUrl } : {}), strictProxy: !!proxyUrl || config.strictProxy, signal: AbortSignal.timeout(20000) };
    const refreshed = await refreshAndUpdateCredentials(connection, false, proxyOptions);
    const token = refreshed.connection.accessToken;
    if (!connection.email) throw appealError("此账号未记录登录邮箱，请重新授权后再申诉。", 409);
    if (session.status === "closed") return;
    // Verify identity once, inside the isolated browser using the same account proxy.
    session.user = { email: connection.email, accessToken: token };
    const browser = await launchAppealBrowser({ proxyUrl, onExit: () => {
      if (session.status !== "closed" && session.status !== "error") {
        session.status = "error"; session.message = "申诉浏览器已退出，请重新打开。"; session.user = null;
        session.browser?.close().catch(() => {});
      }
    } });
    session.browser = browser;
    if (session.status === "closed") { await browser.close(); session.browser = null; return; }
    await browser.navigate();
    session.status = "loading"; session.message = "正在加载帮助中心。如出现网页验证，请在窗口内完成。";
  } catch (error) {
    if (session.status === "closed") return;
    await session.browser?.close(); session.browser = null; session.user = null;
    session.status = "error";
    session.message = error.public || /^[\u4e00-\u9fff]/.test(error.message) ? error.message : "无法打开申诉窗口，请检查账号授权和代理连接后重试。";
  }
}

export async function startAppeal(connectionId, owner, requestId) {
  initialize();
  if (typeof connectionId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(connectionId)) throw appealError("账号 ID 无效。");
  const connection = await getProviderConnectionById(connectionId);
  if (!connection || connection.provider !== "codex" || !connection.accessToken) throw appealError("请选择已授权的 Codex 账号。", 404);
  if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)) throw appealError("启动请求 ID 无效。");
  const existing = [...state.sessions.values()].find(s => s.owner === owner && s.requestId === requestId && s.connectionId === connectionId);
  if (existing) return { id: existing.id, account: existing.account };
  // Reserve a slot before asynchronous startup, including disabled accounts.
  if ([...state.sessions.values()].filter(s => !["closed", "error"].includes(s.status)).length >= MAX_BROWSERS) throw appealError("已有两个申诉窗口，请先关闭其中一个再打开。", 409);
  const session = { id: randomUUID(), requestId, owner, account: connection.email || connection.name, connectionId, status: "starting", message: "正在验证账号并启动独立浏览器…", lastSeen: Date.now(), lastInput: Date.now(), browser: null, user: null, authenticating: false, capturing: null };
  state.sessions.set(session.id, session);
  session.starting = prepare(session, connection);
  return { id: session.id, account: session.account };
}

async function authenticate(session) {
  if (session.authenticating || !session.user || !session.browser || ["closed", "error"].includes(session.status)) return;
  session.authenticating = true;
  try {
    const result = await session.browser.authenticate(session.user);
    if (["closed", "error"].includes(session.status)) return;
    if (result?.error) {
      await session.browser.close(); session.browser = null; session.user = null;
      session.status = "error"; session.message = result.error;
    } else if (result?.ready) { session.status = "ready"; session.message = "账号已就绪，可在客服对话中自行填写并发送申诉。"; }
  } catch { /* A document can be replaced while navigating; retry on the next frame. */ }
  finally { session.authenticating = false; }
}

export async function appealFrame(id, owner, capture = true) {
  const session = lookup(id, owner);
  const result = () => ({ id, account: session.account, status: session.status, message: session.message, ...VIEWPORT });
  if (!session.browser || ["closed", "error"].includes(session.status) || !capture) return result();
  authenticate(session);
  // One capture at a time even if the client reconnects or retries a slow frame.
  session.capturing ||= session.browser.screenshot().finally(() => { session.capturing = null; });
  try { return { ...result(), image: await session.capturing }; }
  catch { return result(); }
}

export function validateAppealAction(action) {
  if (!action || typeof action !== "object") throw appealError("操作无效。");
  if (action.type === "close") return;
  if (action.type === "text" && typeof action.text === "string" && action.text.trim() && action.text.length <= 20000) return;
  const point = Number.isFinite(action.x) && Number.isFinite(action.y) && action.x >= 0 && action.y >= 0 && action.x < VIEWPORT.width && action.y < VIEWPORT.height;
  if (action.type === "click" && point) return;
  if (action.type === "wheel" && point && Number.isFinite(action.deltaY) && Math.abs(action.deltaY) <= 2000) return;
  if (action.type === "key" && ["Enter", "Backspace", "Delete", "Tab", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(action.key)) return;
  throw appealError("操作无效。");
}

export async function appealAction(id, owner, action) {
  validateAppealAction(action);
  const session = lookup(id, owner);
  if (action.type === "close") { await close(session); state.sessions.delete(id); return { closed: true }; }
  if (!session.browser || ["closed", "error"].includes(session.status)) throw appealError("申诉浏览器尚未就绪。", 409);
  session.lastInput = Date.now();
  const browser = session.browser;
  if (action.type === "text") {
    if (session.status !== "ready") throw appealError("请等待所选账号登录完成。", 409);
    const focused = await browser.evaluate(`(async()=>{const c=document.querySelector('openai-chatkit');if(!c?.focusComposer)return false;await c.focusComposer();return true;})()`);
    if (!focused) throw appealError("请先在窗口右下角打开客服对话。", 409);
    await browser.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
    await browser.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
    await browser.send("Input.insertText", { text: action.text });
  } else if (action.type === "click") {
    await browser.send("Input.dispatchMouseEvent", { type: "mousePressed", x: action.x, y: action.y, button: "left", clickCount: 1 });
    await browser.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: action.x, y: action.y, button: "left", clickCount: 1 });
  } else if (action.type === "wheel") {
    await browser.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: action.x, y: action.y, deltaX: 0, deltaY: action.deltaY });
  } else if (action.type === "key") {
    const codes = { Enter: 13, Backspace: 8, Delete: 46, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35 };
    const key = { key: action.key, code: action.key, windowsVirtualKeyCode: codes[action.key] };
    await browser.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key });
    await browser.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  }
  return { ok: true };
}
