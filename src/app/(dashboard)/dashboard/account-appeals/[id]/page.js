"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Button from "@/shared/components/Button";

async function request(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || "申诉窗口连接失败。"), { status: response.status });
  return data;
}
const post = body => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export default function AccountAppealPage() {
  const { id: connectionId } = useParams();
  return <AppealWorkspace key={connectionId} connectionId={connectionId} />;
}

function AppealWorkspace({ connectionId }) {
  const [session, setSession] = useState(null);
  const [frame, setFrame] = useState(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  const sessionRef = useRef(null), startupRef = useRef(null), mounted = useRef(false), viewer = useRef(null);
  const ended = ["closed", "error"].includes(frame?.status);
  const hasFrame = !!frame?.image && !ended;

  useEffect(() => {
    mounted.current = true;
    let timer, stopped = false;
    const controller = new AbortController();
    const release = () => {
      if (sessionRef.current) navigator.sendBeacon(`/api/account-appeals/${sessionRef.current.id}`, new Blob([JSON.stringify({ type: "close" })], { type: "application/json" }));
    };
    window.addEventListener("pagehide", release);
    async function poll(current) {
      if (stopped || !mounted.current || sessionRef.current?.id !== current.id) return;
      try {
        const data = await request(`/api/account-appeals/${current.id}?frame=${document.hidden ? "0" : "1"}`, { signal: controller.signal });
        if (stopped || !mounted.current || sessionRef.current?.id !== current.id) return;
        setFrame(previous => ({ ...data, image: data.image || previous?.image }));
        setError("");
        if (["closed", "error"].includes(data.status)) return;
      } catch (cause) {
        if (stopped || cause.name === "AbortError" || sessionRef.current?.id !== current.id) return;
        setError(cause.message);
        if (cause.status === 404 || cause.status === 401) { setFrame(null); return; }
      }
      timer = setTimeout(() => poll(current), document.hidden ? 10000 : 1200);
    }
    startupRef.current ||= request("/api/account-appeals", post({ connectionId, requestId: crypto.randomUUID() }));
    startupRef.current.then(current => {
      sessionRef.current = current;
      if (!mounted.current) { release(); return; }
      if (stopped) return;
      setSession(current); poll(current);
    }).catch(cause => { if (!stopped && mounted.current) setError(cause.message); });
    return () => {
      mounted.current = false; stopped = true; clearTimeout(timer); controller.abort();
      window.removeEventListener("pagehide", release);
      // React's development effect replay must not close its own newly opened session.
      setTimeout(() => { if (!mounted.current) release(); }, 0);
    };
  }, [connectionId, attempt]);

  const act = useCallback(async action => {
    if (!sessionRef.current) return;
    try { await request(`/api/account-appeals/${sessionRef.current.id}`, post(action)); setError(""); }
    catch (cause) { setError(cause.message); throw cause; }
  }, []);
  const point = event => {
    const box = viewer.current.getBoundingClientRect();
    return { x: Math.min(1279, Math.max(0, (event.clientX - box.left) * 1280 / box.width)), y: Math.min(899, Math.max(0, (event.clientY - box.top) * 900 / box.height)) };
  };
  useEffect(() => {
    const node = viewer.current;
    if (!node) return;
    let lastWheel = 0;
    const wheel = event => {
      event.preventDefault();
      if (Date.now() - lastWheel < 100) return;
      lastWheel = Date.now();
      act({ type: "wheel", ...point(event), deltaY: Math.max(-1200, Math.min(1200, event.deltaY * (event.deltaMode === 1 ? 20 : 1))) }).catch(() => {});
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, [act, hasFrame]);

  async function fill() {
    setBusy(true); setNotice("");
    try { await act({ type: "text", text: draft }); setNotice("已填入客服输入框，请在窗口内核对并点击发送。"); }
    catch { /* The action displays its own error. */ }
    finally { setBusy(false); }
  }
  async function stop() {
    setBusy(true);
    try { await act({ type: "close" }); sessionRef.current = null; setFrame({ status: "closed", message: "申诉窗口已关闭，浏览器资源已释放。" }); }
    catch { /* The action displays its own error. */ }
    finally { setBusy(false); }
  }
  function retry() {
    sessionRef.current = null; startupRef.current = null; setSession(null); setFrame(null); setError(""); setNotice(""); setAttempt(n => n + 1);
  }
  return <main className="mx-auto max-w-[1440px] space-y-4 p-4 md:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-xl font-semibold">账号申诉</h1><p className="mt-1 break-all text-sm text-text-muted">{session?.account || "正在读取账号…"}</p></div>
      {ended || error && !frame ? <Button variant="secondary" onClick={retry} icon="refresh">重新打开</Button>
        : <Button variant="secondary" onClick={stop} disabled={!session} loading={busy} icon="close">结束申诉</Button>}
    </div>
    <p className="text-sm text-text-muted">独立浏览器会话，与日常浏览器登录互不影响。关闭此页面后释放资源，15 分钟无操作也会自动关闭。</p>
    <p role="status" className={`text-sm ${frame?.status === "error" ? "text-red-600" : "text-text-muted"}`}>{frame?.message || "正在打开独立申诉窗口…"}</p>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="overflow-hidden rounded-xl border border-border bg-surface-2">
        {frame?.image && !ended ? <div ref={viewer} tabIndex={0} role="application" aria-label="独立的 OpenAI 帮助中心窗口"
          className="relative cursor-default outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
          onClick={event => { viewer.current.focus(); act({ type: "click", ...point(event) }).catch(() => {}); }}
          onKeyDown={event => { if (["Enter", "Backspace", "Delete", "Tab", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) { event.preventDefault(); act({ type: "key", key: event.key }).catch(() => {}); } }}>
          {/* Browser frames are transient; retaining only the latest image bounds client memory. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`data:image/jpeg;base64,${frame.image}`} alt="OpenAI 帮助中心实时画面" width={1280} height={900} className="block h-auto w-full select-none" draggable={false} />
        </div> : <div className="flex aspect-[1280/900] items-center justify-center p-8 text-center text-sm text-text-muted">{ended ? frame.message : "正在准备帮助中心…"}</div>}
      </div>
      <div className="space-y-3 rounded-xl border border-border bg-surface p-4">
        <label htmlFor="appeal-draft" className="block text-sm font-semibold">申诉文案</label>
        <textarea id="appeal-draft" rows={12} maxLength={20000} value={draft} onChange={event => setDraft(event.target.value)}
          placeholder="在这里填写内容，再填入左侧客服对话框。" className="w-full resize-y rounded-lg border border-border bg-surface-2 p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary" />
        <Button fullWidth onClick={fill} loading={busy} disabled={frame?.status !== "ready" || !draft.trim()} icon="edit_note">填入客服输入框</Button>
        <p className="text-xs leading-5 text-text-muted">此按钮只填写内容。核对后，请在左侧帮助中心点击发送。</p>
        {notice && <p role="status" className="text-xs text-emerald-700">{notice}</p>}
      </div>
    </div>
  </main>;
}
