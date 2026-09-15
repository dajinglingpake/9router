"use client";

const formatDate = value => new Date(value).toLocaleString("zh-CN", { hour12: false });

export default function AccountExpiry({ connection }) {
  const expiry = connection.accountExpiry;
  const token = connection.expiresAt && Number.isFinite(new Date(connection.expiresAt).getTime()) ? connection.expiresAt : null;
  return (
    <div className="mt-1 text-xs text-text-muted">
      <p title={expiry?.source === "subscription" ? `订阅记录${expiry.checkedAt ? `，同步于 ${formatDate(expiry.checkedAt)}` : ""}；续费后需刷新授权核实。` : "可在编辑账号中设置到期时间"}>
        {expiry?.source === "subscription" ? "订阅到期" : "账号到期"}：{expiry ? formatDate(expiry.at) : "未提供"}
        {expiry?.source === "subscription" && <span className="ml-1">（上次同步）</span>}
      </p>
      {token && <p title="登录凭证可自动刷新，此时间不代表会员到期">凭证到期：{formatDate(token)}</p>}
    </div>
  );
}
