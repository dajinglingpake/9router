"use client";

import { useEffect, useRef, useState } from "react";
import Modal from "./Modal";
import Button from "./Button";

const URL = "/api/oauth/codex/browser-login";
const KEYS = ["Enter", "Backspace", "Delete", "Tab", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
const post = body => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function request(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || "登录窗口连接失败。"), { status: response.status });
  return data;
}

export default function CodexBrowserLoginModal({ connection, onClose, onSuccess }) {
  const [frame, setFrame] = useState(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const session = useRef(null), startup = useRef(null), mounted = useRef(false), viewer = useRef(null);
  const inputQueue = useRef(Promise.resolve()), lastWheel = useRef(0), onSuccessRef = useRef(onSuccess);
  const ended = ["done", "closed", "error"].includes(frame?.status);
  useEffect(() => { onSuccessRef.current = onSuccess; }, [onSuccess]);

  useEffect(() => {
    mounted.current = true;
    let timer, stopped = false;
    const controller = new AbortController();
    const release = () => {
      if (session.current) navigator.sendBeacon(URL, new Blob([JSON.stringify({ type: "close", id: session.current.id })], { type: "application/json" }));
      session.current = null;
    };
    window.addEventListener("pagehide", release);
    async function poll(current) {
      if (stopped || session.current?.id !== current.id) return;
      try {
        const result = await request(`${URL}?id=${encodeURIComponent(current.id)}&frame=${document.hidden ? "0" : "1"}`, { signal: controller.signal });
        if (stopped || session.current?.id !== current.id) return;
        setFrame(previous => ({ ...result, image: result.image || (!["done", "closed", "error"].includes(result.status) ? previous?.image : null) }));
        setError("");
        if (result.status === "done") { onSuccessRef.current?.(); return; }
        if (["closed", "error"].includes(result.status)) return;
      } catch (error) {
        if (stopped) return;
        setError(error.message);
        if (error.status === 401 || error.status === 404) { setFrame({ status: "error", message: error.message }); return; }
      }
      timer = setTimeout(() => poll(current), document.hidden ? 10000 : 1200);
    }
    startup.current ||= request(URL, post({ type: "start", connectionId: connection?.id,
      requestId: Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join(""),
    }));
    startup.current.then(current => {
      session.current = current;
      if (!mounted.current) { release(); return; }
      if (!stopped) void poll(current);
    }).catch(error => { if (!stopped) { setError(error.message); setFrame({ status: "error" }); } });
    return () => {
      mounted.current = false; stopped = true; clearTimeout(timer); controller.abort();
      window.removeEventListener("pagehide", release);
      // React's development effect replay must not close the session it reuses.
      setTimeout(() => { if (!mounted.current) release(); }, 0);
    };
  }, [connection?.id, attempt]);

  const act = action => {
    const id = session.current?.id;
    inputQueue.current = inputQueue.current.catch(() => {}).then(async () => {
      if (!id || session.current?.id !== id) return;
      try { await request(URL, post({ ...action, id })); }
      catch (error) { if (mounted.current) setError(error.message); }
    });
  };
  const point = event => {
    const box = viewer.current.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1279, (event.clientX - box.left) * 1280 / box.width)), y: Math.max(0, Math.min(899, (event.clientY - box.top) * 900 / box.height)) };
  };
  useEffect(() => {
    const node = viewer.current;
    if (!node) return;
    const wheel = event => {
      event.preventDefault();
      if (Date.now() - lastWheel.current < 100) return;
      lastWheel.current = Date.now();
      act({ type: "wheel", ...point(event), deltaY: Math.max(-2000, Math.min(2000, event.deltaY)) });
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  });

  const retry = () => {
    if (session.current) navigator.sendBeacon(URL, new Blob([JSON.stringify({ type: "close", id: session.current.id })], { type: "application/json" }));
    session.current = null; startup.current = null; setFrame(null); setError(""); setAttempt(value => value + 1);
  };
  return <Modal isOpen onClose={onClose} title={connection ? "重新登录 OpenAI Codex" : "添加 OpenAI Codex 账号"} size="full" closeOnOverlay={false}
    footer={<>{frame?.status === "error" && <Button variant="secondary" onClick={retry}>重新打开</Button>}
      <Button variant={frame?.status === "done" ? "primary" : "ghost"} onClick={onClose}>{frame?.status === "done" ? "完成" : "取消"}</Button></>}>
    <div className="space-y-3">
      <p className="break-all text-sm font-medium">{connection ? `请使用原账号 ${connection.email || connection.name} 登录。` : "请登录要添加的 ChatGPT 账号。"}</p>
      <p className="text-xs text-text-muted">登录后自动更新账号授权并记录完整网页 Session，之后可通过「下载 Session」导出。</p>
      <p role="status" className={`text-sm ${frame?.status === "done" ? "text-green-600" : "text-text-muted"}`}>{frame?.message || "正在打开登录窗口…"}</p>
      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
      {frame?.image && !ended ? <>
        <p className="text-xs text-text-muted">点击网页输入框后可直接输入或粘贴，验证码也在此窗口填写。</p>
        <div ref={viewer} tabIndex={0} role="application" aria-label="ChatGPT 登录窗口"
          className="overflow-hidden rounded-lg border border-border outline-none focus-visible:ring-2 focus-visible:ring-primary"
          onClick={event => { viewer.current.focus(); act({ type: "click", ...point(event) }); }}
          onPaste={event => { event.preventDefault(); const text = event.clipboardData.getData("text/plain"); if (text) act({ type: "text", text }); }}
          onKeyDown={event => {
            if (event.ctrlKey || event.metaKey) {
              if (event.key.toLowerCase() === "a") { event.preventDefault(); act({ type: "key", key: "a", modifiers: 2 }); }
              return;
            }
            if (KEYS.includes(event.key)) { event.preventDefault(); event.stopPropagation(); act({ type: "key", key: event.key, modifiers: event.shiftKey ? 8 : 0 }); }
            else if (event.key.length === 1 && !event.altKey) { event.preventDefault(); act({ type: "text", text: event.key }); }
          }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`data:image/jpeg;base64,${frame.image}`} alt="ChatGPT 登录实时画面" width={1280} height={900} className="block h-auto w-full select-none" draggable={false} />
        </div>
      </> : !ended && <div className="flex aspect-[1280/600] items-center justify-center text-sm text-text-muted">正在准备登录页面…</div>}
    </div>
  </Modal>;
}
