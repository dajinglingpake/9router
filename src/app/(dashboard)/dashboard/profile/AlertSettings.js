"use client";

import { useEffect, useState } from "react";
import { Card, Input, Button, Toggle } from "@/shared/components";
import { ALERT_DEFAULTS } from "@/lib/alerts/config";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

export default function AlertSettings() {
  const [config, setConfig] = useState({ ...ALERT_DEFAULTS });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [showWebhook, setShowWebhook] = useState(false);
  const { copied, copy } = useCopyToClipboard();
  useEffect(() => {
    fetch("/api/settings/alerts").then(async response => {
      if (!response.ok) throw new Error("请登录后配置告警");
      setConfig({ ...ALERT_DEFAULTS, ...await response.json() });
      setLoading(false);
    }).catch(error => setMessage(error.message));
  }, []);

  const submit = async test => {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/settings/alerts", {
        method: test ? "POST" : "PATCH", headers: { "Content-Type": "application/json" },
        ...(test ? {} : { body: JSON.stringify(config) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "操作失败");
      if (!test) setConfig(previous => ({ ...previous, ...result }));
      setMessage(test ? result.message : "告警配置已保存");
      const statusResponse = await fetch("/api/settings/alerts");
      if (statusResponse.ok) {
        const latest = await statusResponse.json();
        setConfig(previous => ({ ...previous, status: latest.status, ...(!test ? { webhookUrl: latest.webhookUrl || "" } : {}) }));
      }
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <Card>
    <div className="flex items-center justify-between mb-4">
      <h2 className="text-lg font-semibold">企业微信告警</h2>
      <Toggle checked={config.enabled} onChange={() => setConfig({ ...config, enabled: !config.enabled })} disabled={loading || busy} />
    </div>
    <div className="space-y-4">
      <div className="relative">
        <Input label="群机器人 Webhook" aria-label="群机器人 Webhook" type={showWebhook ? "text" : "password"} autoComplete="off"
          value={config.webhookUrl} disabled={loading || busy} inputClassName="pr-20"
          placeholder={config.configured ? "留空保留原地址" : "填写企业微信群机器人地址"}
          onChange={e => setConfig({ ...config, webhookUrl: e.target.value })} />
        <div className="absolute right-2 bottom-1.5 flex items-center gap-1">
          <button type="button" aria-label={showWebhook ? "隐藏地址" : "显示地址"} title={showWebhook ? "隐藏地址" : "显示地址"}
            disabled={loading || busy || !config.webhookUrl} onClick={() => setShowWebhook(!showWebhook)}
            className="size-8 rounded text-text-muted hover:bg-black/5 disabled:opacity-40">
            <span className="material-symbols-outlined text-[18px]">{showWebhook ? "visibility_off" : "visibility"}</span>
          </button>
          <button type="button" aria-label={copied ? "已复制地址" : "复制地址"} title={copied ? "已复制地址" : "复制地址"}
            disabled={loading || busy || !config.webhookUrl} onClick={async () => { if (!await copy(config.webhookUrl)) setMessage("复制失败，请显示地址后手动复制"); }}
            className="size-8 rounded text-text-muted hover:bg-black/5 disabled:opacity-40">
            <span className="material-symbols-outlined text-[18px]">{copied ? "check" : "content_copy"}</span>
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {[["quotaPercent", "额度剩余 ≤ (%)", 1, 99], ["balanceThreshold", "余额 ≤（账户币种）", 0, 10000], ["expiryDays", "到期前提醒（天）", 1, 90], ["cooldownMinutes", "重复告警间隔（分钟）", 1, 1440]].map(([key, label, min, max]) =>
          <Input key={key} label={label} type="number" min={min} max={max} step={key === "balanceThreshold" ? "0.01" : "1"} value={config[key]} disabled={loading || busy}
            onChange={e => setConfig({ ...config, [key]: Number(e.target.value) })} />)}
      </div>
      <p className="text-xs text-text-muted">限流、过载和凭证失效即时提醒；额度与到期每 5 分钟检查，每类每天最多提醒一次。余额阈值适用于 DeepSeek。</p>
      <div className="flex items-center gap-2">
        <Button disabled={loading || busy} onClick={() => submit(false)}>保存</Button>
        <Button variant="secondary" disabled={loading || busy || !config.configured} onClick={() => submit(true)}>测试推送</Button>
      </div>
      {message && <p role="status" className="text-sm">{message}</p>}
      {config.status?.lastSentAt && <p className="text-xs text-text-muted">最近推送：{new Date(config.status.lastSentAt).toLocaleString("zh-CN")}</p>}
      {config.status?.lastError && <p className="text-xs text-red-500">{config.status.lastError}</p>}
    </div>
  </Card>;
}
