import Badge from "./Badge";
import { getExclusiveApiKeyIds } from "@/shared/utils/accountApiKeyBindings.js";

export default function AccountApiKeyBindings({ connection, showShared = false }) {
  const ids = getExclusiveApiKeyIds(connection);
  if (!ids.length) return showShared ? <p className="text-xs text-text-muted">共享账号 · 未绑定</p> : null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="账号绑定人">
      <span className="text-text-muted">专用绑定：</span>
      {ids.map((id, index) => <Badge key={id} variant="primary" size="sm">
        {connection.exclusiveApiKeyNames?.[index] || id.slice(0, 8)}
      </Badge>)}
    </div>
  );
}
