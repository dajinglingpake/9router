"use client";

import { useState } from "react";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

function getErrorMessage(status, error) {
  if (status === 400) return error || "请输入有效用户名。";
  if (status === 403) return "该用户名对应的 API Key 已被禁用，请联系管理员。";
  if (status === 404) return "用户名不存在，或管理员尚未预先创建对应的 API Key。";
  if (status === 409) return "该用户名的 API Key 已领取过。每个用户名只能领取一次。";
  return error || "领取失败，请稍后重试。";
}

export default function ClaimKeyPage() {
  const [username, setUsername] = useState("");
  const [allowedIps, setAllowedIps] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [copyError, setCopyError] = useState("");
  const { copied, copy } = useCopyToClipboard();

  const handleSubmit = async (event) => {
    event.preventDefault();
    setLoading(true);
    setResult(null);
    setError("");
    setCopyError("");

    try {
      const response = await fetch("/api/keys/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, allowedIps }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(getErrorMessage(response.status, data.error));
        return;
      }
      setResult(data);
    } catch (claimError) {
      setError(claimError.message || "领取失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  };

  const copyApiKey = async () => {
    if (!result?.apiKey) return;
    setCopyError("");
    const success = await copy(result.apiKey, "claimed-api-key");
    if (!success) {
      setCopyError("复制失败，请手动选中上方 API Key 后复制。");
    }
  };

  return (
    <main className="min-h-screen bg-[#101418] text-slate-100">
      <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center px-5 py-10">
        <div className="mb-8">
          <p className="mb-3 text-sm font-medium text-cyan-300">9router API Key</p>
          <h1 className="text-3xl font-semibold tracking-normal text-white">领取个人 API Key</h1>
          <p className="mt-3 text-sm leading-6 text-slate-400">
            输入平台管理员预先创建的用户名。领取成功后请立即保存 API Key；每个用户名只能领取一次，默认只允许当前 IP 使用。
          </p>
        </div>

        <section className="rounded-lg border border-slate-700 bg-slate-900/80 p-5 shadow-xl shadow-black/20">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <label className="flex flex-col gap-2 text-sm font-medium text-slate-200">
              用户名
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                className="h-11 rounded-md border border-slate-700 bg-slate-950 px-3 text-base text-white outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/20"
                placeholder="请输入你的用户名"
                autoComplete="off"
              />
            </label>

            <label className="flex flex-col gap-2 text-sm font-medium text-slate-200">
              其他允许 IP（可选）
              <textarea
                value={allowedIps}
                onChange={(event) => setAllowedIps(event.target.value)}
                className="min-h-24 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-base text-white outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/20"
                placeholder="多个 IP 可用逗号、空格或换行分隔"
                autoComplete="off"
              />
              <span className="text-xs leading-5 text-slate-500">
                当前访问 IP 会自动加入允许列表。领取后如需调整，请联系管理员在平台修改。
              </span>
            </label>

            <button
              type="submit"
              disabled={loading || !username.trim()}
              className="h-11 rounded-md bg-cyan-400 px-4 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
            >
              {loading ? "领取中..." : "领取 API Key"}
            </button>
          </form>

          {error && (
            <div className="mt-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          )}

          {result?.apiKey && (
            <div className="mt-5 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-4">
              <div className="mb-2 text-sm font-medium text-emerald-200">领取成功</div>
              <div className="break-all rounded bg-slate-950 px-3 py-2 font-mono text-sm text-emerald-100">
                {result.apiKey}
              </div>
              <button
                type="button"
                onClick={copyApiKey}
                className="mt-3 h-9 rounded-md border border-emerald-400/40 px-3 text-sm font-medium text-emerald-100 transition hover:bg-emerald-400/10"
              >
                {copied === "claimed-api-key" ? "已复制" : "复制 API Key"}
              </button>
              {copyError && (
                <div className="mt-2 text-xs leading-5 text-amber-100">
                  {copyError}
                </div>
              )}
              {result.allowedIps?.length > 0 && (
                <div className="mt-3 text-xs leading-5 text-emerald-100/80">
                  允许 IP：{result.allowedIps.join(", ")}
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
