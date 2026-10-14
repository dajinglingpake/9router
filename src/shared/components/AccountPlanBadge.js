import { getDisplayAccountPlan } from "@/shared/utils/accountPlan.js";

export default function AccountPlanBadge({ connection, usage }) {
  const plan = getDisplayAccountPlan(connection, usage);
  if (!plan) return null;
  const source = { usage: "配额接口记录", credentials: "登录凭证记录", account: "已保存的授权资料" }[plan.source];
  const description = source ? `${source}${plan.checkedAt ? ` · ${new Date(plan.checkedAt).toLocaleString("zh-CN", { hour12: false })}` : ""}` : "未获取到可识别的套餐信息";
  const label = plan.type === "unknown" ? plan.label : `套餐：${plan.label}`;
  return <span data-i18n-skip data-account-plan={plan.type} title={description} aria-label={`${label}，${description}`} className="my-1 inline-flex max-w-full items-center rounded-md border border-border bg-surface-2 px-2 py-1 text-xs font-medium leading-5 text-text-main">{label}</span>;
}
