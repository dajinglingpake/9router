export default function AccountAppealLink({ account }) {
  return <a href={`/dashboard/account-appeals/${encodeURIComponent(account.id)}`} target="_blank" rel="noopener noreferrer"
    className="inline-flex h-7 items-center gap-2 rounded-lg px-3 text-xs font-semibold text-text-muted hover:bg-surface-2 hover:text-text-main"
    aria-label={`申诉账号：${account.name || account.email}`}>
    <span aria-hidden="true" className="material-symbols-outlined text-[18px]">support_agent</span>申诉
  </a>;
}
