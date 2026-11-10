import { randomUUID } from "node:crypto";
import { getSettings } from "@/lib/localDb";
import { updateProviderConnection } from "@/lib/db/repos/connectionsRepo.js";
import { getCodexReloginTarget } from "./reloginCodex.js";
import { generateAuthData } from "./providers.js";
import { CODEX_CONFIG } from "./constants/oauth.js";
import { startCodexProxy, registerCodexSession, getCodexSessionStatus, clearCodexSession } from "./utils/server.js";
import { launchAppealBrowser, VIEWPORT } from "../accountAppeals/browser.mjs";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { ensureOutboundProxyInitialized } from "@/lib/network/initOutboundProxy";
import { parseChatgptSession, chatgptSessionError } from "./chatgptSession.js";

const state = globalThis.__nineRouterCodexBrowserLogin ||= { sessions: new Map(), timer: null };
const ended = session => ["done", "closed", "error"].includes(session.status);
const KEYS = { Enter: 13, Backspace: 8, Delete: 46, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, a: 65 };

// Executed in the ChatGPT tab, using only that browser's real login cookies.
export async function readChatgptSession() {
  if (location.hostname !== "chatgpt.com") return null;
  const response = await fetch("/api/auth/session", { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(10000) });
  if (!response.ok) return null;
  const raw = await response.text();
  return raw.length <= 2 * 1024 * 1024 ? raw : null;
}

async function dispose(session) {
  const browser = session.browser;
  session.browser = null;
  await browser?.close();
}

async function close(session) {
  session.status = "closed";
  if (session.oauthState) clearCodexSession(session.oauthState);
  await dispose(session);
  await session.starting;
  await dispose(session);
  session.webSession = null;
}

function lookup(id, owner) {
  const session = state.sessions.get(id);
  if (!session || session.owner !== owner) throw chatgptSessionError("登录窗口已结束，请重新打开。", 404);
  session.lastSeen = Date.now();
  return session;
}

async function prepare(session, connection) {
  try {
    await ensureOutboundProxyInitialized();
    const proxy = await resolveConnectionProxyConfig(connection?.providerSpecificData || {});
    const settings = await getSettings();
    const proxyUrl = proxy.connectionProxyEnabled ? proxy.connectionProxyUrl : settings.outboundProxyEnabled ? settings.outboundProxyUrl : null;
    if (proxy.vercelRelayUrl || (proxy.strictProxy && !proxyUrl)) {
      throw chatgptSessionError("此账号没有可用于网页登录的 HTTP 或 SOCKS 代理。");
    }
    if (ended(session)) return;
    session.browser = await launchAppealBrowser({ proxyUrl, captureHelp: false, followPopups: true, allowLocalCallbacks: true, onExit: () => {
      // The OAuth callback page may close itself after a successful exchange.
      if (!ended(session) && getCodexSessionStatus(session.oauthState)?.status !== "done") {
        session.status = "error"; session.message = "登录浏览器已关闭，请重新登录。";
      }
      dispose(session).catch(() => {});
    } });
    if (ended(session)) { await dispose(session); return; }
    await session.browser.navigate("https://chatgpt.com/");
    if (!ended(session)) { session.status = "web"; session.message = connection ? "请登录原账号；网页 Session 将在授权完成后自动记录。" : "请登录要添加的 ChatGPT 账号；网页 Session 将在授权完成后自动记录。"; }
  } catch (error) {
    if (session.status !== "closed") {
      session.status = "error";
      session.message = error.status ? error.message : "无法打开登录窗口，请检查账号代理和浏览器运行时。";
    }
    await dispose(session);
  }
}

export async function startCodexBrowserLogin(connectionId, owner, requestId, appPort) {
  if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)) throw chatgptSessionError("登录请求 ID 无效。", 400);
  const connection = connectionId === undefined ? null : await getCodexReloginTarget(connectionId);
  if (connection && !connection.email) throw chatgptSessionError("此账号尚未记录邮箱，请先补充邮箱。");
  const targetId = connection?.id || null;
  for (const session of state.sessions.values()) {
    if (session.owner === owner && session.connectionId === targetId && session.requestId === requestId && !ended(session)) return { id: session.id };
  }
  if ([...state.sessions.values()].some(session => !ended(session))) throw chatgptSessionError("已有 Codex 登录窗口，请先关闭后再试。");
  if (!state.timer) {
    state.timer = setInterval(() => {
      for (const [id, session] of state.sessions) {
        if (Date.now() - session.lastSeen > 60000 || Date.now() - session.lastInput > 15 * 60000) {
          state.sessions.delete(id); close(session).catch(() => {});
        }
      }
    }, 10000);
    state.timer.unref();
    process.once("exit", () => {
      for (const session of state.sessions.values()) if (session.browser?.pid) {
        try { process.kill(-session.browser.pid, "SIGKILL"); } catch { /* Already exited. */ }
      }
    });
  }
  const session = { id: randomUUID(), connectionId: targetId, owner, requestId, appPort, status: "starting", message: "正在打开 ChatGPT 登录窗口…", lastSeen: Date.now(), lastInput: Date.now(), browser: null };
  state.sessions.set(session.id, session);
  session.starting = prepare(session, connection);
  return { id: session.id };
}

async function check(session) {
  try {
    if (session.status === "web" && session.browser) {
      const raw = await session.browser.evaluateMain(`(${readChatgptSession.toString()})()`);
      if (!raw || ended(session)) return;
      const connection = session.connectionId ? await getCodexReloginTarget(session.connectionId) : null;
      const identity = parseChatgptSession(raw, connection);
      const proxy = await startCodexProxy(session.appPort);
      if (!proxy.success) throw chatgptSessionError("Codex 授权回调端口不可用，请关闭占用 1455 端口的程序后重试。");
      const redirectUri = `http://localhost:${CODEX_CONFIG.fixedPort}${CODEX_CONFIG.callbackPath || "/auth/callback"}`;
      const auth = await generateAuthData("codex", redirectUri, { loginHint: identity.user.email });
      if (ended(session)) return;
      if (!registerCodexSession({ ...auth, redirectUri, reloginConnectionId: connection?.id || null,
        ...(!connection ? { expectedIdentity: { email: identity.user.email, accountId: identity.account.id } } : {}),
      })) throw new Error("Registration failed");
      session.webSession = { raw, capturedAt: new Date().toISOString() };
      session.oauthState = auth.state;
      session.oauthStartedAt = Date.now();
      session.status = "oauth";
      session.message = "网页 Session 已读取，正在更新 Codex 授权；如出现授权确认，请在窗口中完成。";
      await session.browser.navigate(auth.authUrl);
    } else if (session.status === "oauth") {
      if (Date.now() - session.oauthStartedAt > 300000) throw chatgptSessionError("Codex 授权等待超时，请重新登录。", 400);
      const auth = getCodexSessionStatus(session.oauthState);
      if (auth?.status === "error") throw chatgptSessionError("Codex 授权失败，请重新登录。", 400);
      if (auth?.status !== "done") return;
      if (!auth.connectionId || (session.connectionId && auth.connectionId !== session.connectionId)) throw chatgptSessionError("授权结果与登录账号不一致，未保存 Session。", 400);
      const connection = await getCodexReloginTarget(auth.connectionId);
      parseChatgptSession(session.webSession.raw, connection);
      if (ended(session)) return;
      const saved = await updateProviderConnection(connection.id, { chatgptSession: session.webSession });
      if (!saved) throw chatgptSessionError("账号已删除，未保存 Session。", 404);
      session.status = "done";
      session.connectionId = connection.id;
      session.message = "账号授权已更新，完整网页 Session 已自动记录。";
      session.webSession = null;
      clearCodexSession(session.oauthState);
      await dispose(session);
    }
  } catch (error) {
    if (ended(session)) return;
    if (error.status === 400 || error.status === 404 || (session.status === "oauth" && error.status === 409)) {
      session.status = "error"; session.message = error.message;
      if (session.oauthState) clearCodexSession(session.oauthState);
      session.webSession = null;
      await dispose(session);
    } else if (error.status) session.message = error.message;
    // Navigation replaces the JavaScript context; retry on the next poll.
  }
}

export async function codexBrowserLoginFrame(id, owner, withImage = true) {
  const session = lookup(id, owner);
  const result = () => ({ id, status: session.status, message: session.message, ...VIEWPORT });
  if (!ended(session) && ["web", "oauth"].includes(session.status) && !session.checking && Date.now() >= (session.nextCheckAt || 0)) {
    session.nextCheckAt = Date.now() + 2000;
    session.checking = check(session).finally(() => { session.checking = null; });
  }
  if (!session.browser || ended(session) || !withImage) return result();
  session.capturing ||= session.browser.screenshot().finally(() => { session.capturing = null; });
  try { const image = await session.capturing; return ended(session) ? result() : { ...result(), image }; }
  catch { return result(); }
}

export async function codexBrowserLoginAction(id, owner, action) {
  const session = lookup(id, owner);
  if (action?.type === "close") { await close(session); state.sessions.delete(id); return { closed: true }; }
  if (!session.browser || ended(session)) throw chatgptSessionError("登录窗口尚未就绪。");
  const browser = session.browser;
  const point = Number.isFinite(action?.x) && Number.isFinite(action?.y) && action.x >= 0 && action.y >= 0 && action.x < VIEWPORT.width && action.y < VIEWPORT.height;
  if (action?.type === "text" && typeof action.text === "string" && action.text.length > 0 && action.text.length <= 20000) {
    await browser.send("Input.insertText", { text: action.text });
  } else if (action?.type === "click" && point) {
    await browser.send("Input.dispatchMouseEvent", { type: "mousePressed", x: action.x, y: action.y, button: "left", clickCount: 1 });
    await browser.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: action.x, y: action.y, button: "left", clickCount: 1 });
  } else if (action?.type === "wheel" && point && Number.isFinite(action.deltaY) && Math.abs(action.deltaY) <= 2000) {
    await browser.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: action.x, y: action.y, deltaX: 0, deltaY: action.deltaY });
  } else if (action?.type === "key" && Object.hasOwn(KEYS, action.key) && Number.isInteger(action.modifiers ?? 0) && (action.modifiers ?? 0) >= 0 && (action.modifiers ?? 0) <= 15) {
    const key = { key: action.key, code: action.key === "a" ? "KeyA" : action.key, windowsVirtualKeyCode: KEYS[action.key], modifiers: action.modifiers || 0 };
    await browser.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key });
    await browser.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  } else throw chatgptSessionError("登录窗口操作无效。", 400);
  session.lastInput = Date.now();
  return { ok: true };
}
