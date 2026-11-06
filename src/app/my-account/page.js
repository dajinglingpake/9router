"use client";

import { useEffect, useRef, useState } from "react";

const names = { "5h": "5 小时额度", Weekly: "每周额度", "Monthly (Total)": "每月总额度", Ratelimit: "速率额度" };
const button = "rounded-xl bg-cyan-300 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200 disabled:opacity-50";

function date(value) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "未提供";
}

export default function MyAccountPage() {
  const token = useRef("");
  const [apiKey, setApiKey] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [hasSession, setHasSession] = useState(false);

  async function request(method, credential) {
    const response = await fetch("/api/my-account", {
      method,
      headers: { Authorization: `Bearer ${credential}` },
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401 && (method === "POST" || token.current === credential)) {
        token.current = "";
        setHasSession(false);
        setResult(null);
      }
      throw new Error(data.error || "查询失败，请稍后重试。");
    }
    return data;
  }

  async function refresh() {
    if (!token.current) return;
    const credential = token.current;
    setLoading(true);
    setError("");
    try {
      const data = await request("GET", credential);
      if (token.current === credential) setResult(data);
    } catch (err) {
      if (!token.current || token.current === credential) setError(err.name === "TimeoutError" ? "查询超时，请稍后刷新。" : err.message);
    } finally {
      if (!token.current || token.current === credential) setLoading(false);
    }
  }

  useEffect(() => {
    const consumeFragment = () => {
      const viewToken = new URLSearchParams(window.location.hash.slice(1)).get("session");
      // Remove the short-lived credential before making any requests. Never persist it.
      if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
      if (!viewToken) return;
      token.current = viewToken;
      setResult(null);
      setHasSession(true);
      void refresh();
    };
    consumeFragment();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function login(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const session = await request("POST", apiKey.trim());
      token.current = session.token;
      setHasSession(true);
      setApiKey("");
      setResult(await request("GET", token.current));
    } catch (err) { setError(err.name === "TimeoutError" ? "连接超时，请稍后重试。" : err.message); }
    finally { setLoading(false); }
  }

  return (
    <main className="min-h-screen bg-[#0d151c] px-5 py-12 text-slate-100 sm:py-20">
      <div className="mx-auto max-w-3xl">
        <p className="mb-3 text-sm font-medium tracking-wide text-cyan-300">9ROUTER · 个人用量</p>
        <h1 className="text-3xl font-semibold tracking-normal sm:text-4xl">我的账号与额度</h1>
        <p className="mt-4 text-sm leading-6 text-slate-400">查看你的绑定账号与可用共享账号的额度、重置时间。</p>

        {!hasSession && (
          <form onSubmit={login} className="mt-8 space-y-4 rounded-2xl border border-slate-700 bg-slate-900 p-6">
            <label className="block text-sm" htmlFor="my-api-key">API Key</label>
            <input id="my-api-key" type="password" autoComplete="off" spellCheck={false} value={apiKey}
              onChange={event => setApiKey(event.target.value)} placeholder="输入启动脚本中使用的 API Key"
              className="w-full rounded-lg border border-slate-600 bg-slate-950 px-4 py-3 outline-none focus:border-cyan-300" />
            <button className={button} disabled={loading || !apiKey.trim()}>{loading ? "正在查询…" : "查看我的账号"}</button>
            <p className="text-xs leading-5 text-slate-400">也可以从启动脚本的“我的账号与额度”按钮直接打开。关闭页面后需重新验证。</p>
          </form>
        )}

        {hasSession && (
          <div className="mt-8 flex flex-wrap items-center justify-between gap-4 border-b border-slate-700 pb-6">
            <div><p className="font-medium">{result?.name || "正在读取绑定账号…"}</p>
              {result && <p className="mt-1 text-xs text-slate-400">查询时间：{date(result.checkedAt)}</p>}</div>
            <div className="flex items-center gap-4">
              <button className={button} disabled={loading} onClick={refresh}>{loading ? "查询中…" : "刷新额度"}</button>
              <button className="text-sm text-slate-400 hover:text-white" onClick={() => {
                token.current = ""; setResult(null); setHasSession(false); setError("");
              }} disabled={loading}>退出查看</button>
            </div>
          </div>
        )}
        {error && <p role="alert" className="mt-6 rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-100">{error}</p>}
        {result?.binding === "shared" && <section className="mt-6 rounded-2xl border border-slate-700 bg-slate-900 p-6">
          <h2 className="font-medium">当前使用共享账号池</h2>
          <p className="mt-3 text-sm leading-6 text-slate-400">请求会按管理员设置分配共享账号，下面的额度由多人共同消耗，不是个人独享余额。需要固定 Codex 账号时，请联系管理员绑定。</p>
        </section>}
        {result && result.accounts.length === 0 && <p className="mt-6 text-sm text-slate-400">当前没有可展示的账号额度，请联系管理员确认账号和模型权限。</p>}
        <div className="mt-6 space-y-5" aria-live="polite">
          {result?.accounts.map(account => <section key={account.id} className="rounded-2xl border border-slate-700 bg-slate-900 p-6 sm:p-7">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><p className="text-xs text-cyan-300">{account.providerName}{account.plan ? ` · ${account.plan}` : ""}</p>
                <h2 className="mt-2 break-all text-xl font-semibold">{account.name}</h2></div>
              <span className={`rounded-full px-3 py-1 text-xs ${account.active ? "bg-emerald-400/10 text-emerald-300" : "bg-amber-400/10 text-amber-200"}`}>{account.shared ? "共享 · 多人共用" : account.active ? "已绑定 · 已启用" : "已绑定 · 已停用"}</span>
            </div>
            {account.message && <p className="mt-5 text-sm text-amber-100">{account.message}</p>}
            {account.quotas.map((quota, index) => <div key={`${quota.name}-${index}`} className="mt-6">
              <div className="flex items-center justify-between gap-4 text-sm">
                <span className="text-slate-300">{names[quota.name] || quota.name}</span>
                <strong>{quota.unlimited ? "不限量" : quota.balance !== null ? `${quota.balanceLabel || quota.balance}` : `剩余 ${quota.remainingPercentage}%`}</strong>
              </div>
              {quota.remainingPercentage !== null && <div role="progressbar" aria-label={names[quota.name] || quota.name} aria-valuenow={quota.remainingPercentage} aria-valuemin={0} aria-valuemax={100} className="mt-3 h-2 overflow-hidden rounded-full bg-slate-700">
                <div className={`h-full rounded-full ${quota.remainingPercentage <= 10 ? "bg-amber-300" : "bg-cyan-300"}`} style={{ width: `${quota.remainingPercentage}%` }} />
              </div>}
              {quota.resetAt && <p className="mt-2 text-xs text-slate-500">重置时间：{date(quota.resetAt)}</p>}
            </div>)}
            {account.monthlyCodeUsedPercentage !== undefined && <p className="mt-5 text-xs leading-5 text-slate-400">本月 Kimi Code 已用：总月额度的 {Number(account.monthlyCodeUsedPercentage.toFixed(2))}%，已包含在月总用量中。</p>}
          </section>)}
        </div>
        {result?.accounts.length > 0 && <p className="mt-6 text-xs leading-5 text-slate-500">额度来自上游账号，可能包含该账号在其他客户端的用量。多个使用者绑定同一账号时，额度共同消耗。</p>}
      </div>
    </main>
  );
}
