import Badge from "./Badge";
import { getExclusiveApiKeyIds } from "@/shared/utils/accountApiKeyBindings.js";

export default function AccountApiKeyBindings({ connection, showShared = false }) {
  const ids = getExclusiveApiKeyIds(connection);
  const recentUsers = Array.isArray(connection.recentApiKeyUsers) ? connection.recentApiKeyUsers : null;
  if (!ids.length && recentUsers?.length === 0) return null;
  if (!ids.length && !showShared && !recentUsers?.length) return null;
  const users = ids.length ? ids.map((id, index) => ({ id, name: connection.exclusiveApiKeyNames?.[index] || id.slice(0, 8) })) : recentUsers || [];
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs" aria-label={ids.length ? "账号绑定人" : "最近1小时账号使用人"}>
      <span className="text-text-muted">{ids.length ? "专用绑定：" : "近1小时使用："}</span>
      {users.map(user => <span key={user.id} className="min-w-0 max-w-full" title={user.lastUsedAt ? `最近使用：${new Date(user.lastUsedAt).toLocaleString("zh-CN", { hour12: false })}（含失败尝试）` : user.name}>
        <Badge variant="primary" size="sm" className="max-w-full break-all whitespace-normal text-xs">{user.name}</Badge>
      </span>)}
      {!users.length && <span className="text-text-muted">{recentUsers ? "暂无使用记录" : "使用记录未获取"}</span>}
    </div>
  );
}
