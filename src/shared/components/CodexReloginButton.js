"use client";

import { useState } from "react";
import OAuthModal from "./OAuthModal";
import { OAUTH_PROVIDERS } from "@/shared/constants/providers";

export default function CodexReloginButton({ connection, onSuccess, iconOnly = false, disabled = false }) {
  const [open, setOpen] = useState(false);
  if (connection.provider !== "codex" || !["oauth", "access_token"].includes(connection.authType)) return null;

  return <>
    <button type="button" onClick={() => setOpen(true)} disabled={disabled}
      aria-label="重新登录" title="重新登录 OpenAI Codex"
      className={`${iconOnly ? "flex h-8 w-8 items-center justify-center" : "flex w-full flex-col items-center px-2 py-1"} rounded-lg text-text-muted transition-colors hover:bg-black/5 hover:text-primary disabled:opacity-50 dark:hover:bg-white/5`}>
      <span className="material-symbols-outlined text-[18px]">login</span>
      {!iconOnly && <span className="text-[10px] leading-tight">重新登录</span>}
    </button>
    <OAuthModal isOpen={open} provider="codex" providerInfo={OAUTH_PROVIDERS.codex}
      reloginConnection={connection} onClose={() => setOpen(false)}
      onSuccess={() => { setOpen(false); onSuccess?.(); }} />
  </>;
}
