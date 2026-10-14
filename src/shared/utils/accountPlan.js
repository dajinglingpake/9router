export const ACCOUNT_PLAN_LABELS = {
  free: "免费版", plus: "Plus", pro: "Pro", go: "Go",
  team: "Team", business: "Business", enterprise: "Enterprise", edu: "Edu",
};

export function normalizeAccountPlanType(value) {
  if (typeof value !== "string") return null;
  const type = value.trim().toLowerCase();
  return Object.hasOwn(ACCOUNT_PLAN_LABELS, type) ? type : null;
}

export function getAccountPlanLabel(type) {
  return ACCOUNT_PLAN_LABELS[normalizeAccountPlanType(type)] || "套餐未知";
}

function checkedAt(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

export function getDisplayAccountPlan(connection, usage = null) {
  if (connection?.provider && connection.provider !== "codex") return null;
  if (connection?.provider !== "codex" && !connection?.accountPlan) return null;
  const saved = connection?.accountPlan;
  const type = normalizeAccountPlanType(saved?.type);
  const plan = type ? { type, label: getAccountPlanLabel(type),
    source: ["credentials", "account", "usage"].includes(saved.source) ? saved.source : null,
    checkedAt: checkedAt(saved.checkedAt) } : { type: "unknown", label: "套餐未知", source: null, checkedAt: null };
  const usageType = normalizeAccountPlanType(usage?.plan);
  const usageAt = checkedAt(usage?.cachedAt);
  if (usageType && (!usageAt || !plan.checkedAt || Date.parse(usageAt) >= Date.parse(plan.checkedAt))) {
    return { type: usageType, label: getAccountPlanLabel(usageType), source: "usage", checkedAt: usageAt };
  }
  return plan;
}
