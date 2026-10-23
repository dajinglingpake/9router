export const OFFICIAL_STATUS_URL = "https://status.openai.com";
export const OFFICIAL_STATUS_MAX_AGE_MS = 180_000;

const providerComponents = {
  codex: ["Codex API", "CLI"],
  openai: ["Responses", "Chat Completions"],
};
const componentStates = new Set(["operational", "degraded_performance", "partial_outage", "major_outage", "under_maintenance"]);

export const statusTime = value => {
  if (value == null || value === "") return null;
  const time = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(time) ? time : null;
};

export function isOfficialStatusStale(data, now = Date.now()) {
  const fetchedAt = statusTime(data?.fetchedAt);
  return !data || data.stale || fetchedAt == null || now - fetchedAt > OFFICIAL_STATUS_MAX_AGE_MS;
}

// The public incident feed may omit affected components. Title matches are only
// a reference; they do not establish that a specific account was affected.
export function incidentMentionsProvider(incident, provider) {
  const names = providerComponents[provider];
  if (!names) return false;
  if (incident.components?.some(component => names.includes(component.name))) return true;
  const title = incident.name || "";
  if (provider === "codex") return /\bcodex\b/i.test(title);
  if (/\b(fedramp|ads?|compliance)\b/i.test(title)) return false;
  return /\bresponses(?: api)?\b|\bchat completions\b|\bAPIs\b|\bAPI (?:errors?|requests?|latency|availability)\b/i.test(title);
}

export function normalizeOfficialStatus(summary, components, history, fetchedAt) {
  if (!summary?.status || typeof summary.status.indicator !== "string"
    || !Array.isArray(components?.components) || !components.components.length || !Array.isArray(history?.incidents)) {
    throw new Error("Invalid official status feed");
  }
  const incidents = history.incidents.flatMap(incident => {
    if (!incident?.id || typeof incident.name !== "string") return [];
    const updates = Array.isArray(incident.incident_updates) ? incident.incident_updates : [];
    // display_at is the published event time, which may precede record creation.
    const times = [incident.started_at, incident.created_at, ...updates.map(update => update.display_at || update.created_at)]
      .map(statusTime).filter(time => time != null);
    const startedAt = times.length ? Math.min(...times) : null;
    const resolved = ["resolved", "postmortem"].includes(incident.status);
    const resolvedAt = statusTime(incident.resolved_at)
      ?? statusTime(updates.find(update => update.status === "resolved")?.display_at);
    return [{ id: incident.id, name: incident.name, status: incident.status, resolved,
      startedAt, resolvedAt: resolved ? resolvedAt : null,
      components: Array.isArray(incident.components) ? incident.components.map(({ id, name }) => ({ id, name })) : [],
      url: `${OFFICIAL_STATUS_URL}/incidents/${encodeURIComponent(incident.id)}` }];
  }).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return {
    fetchedAt, stale: false, error: null,
    indicator: summary.status.indicator, description: summary.status.description || "",
    components: components.components.map(({ id, name, status }) => ({ id, name, status })),
    incidents, historyCount: history.incidents.length,
    historyOldestAt: incidents.filter(incident => incident.startedAt != null).at(-1)?.startedAt ?? null,
  };
}

export function getAccountOfficialReference(data, provider, start, end, now = Date.now()) {
  const names = providerComponents[provider];
  if (!names) return null;
  const stale = isOfficialStatusStale(data, now);
  const components = names.map(name => data?.components?.find(component => component.name === name));
  const current = stale || components.some(component => !componentStates.has(component?.status)) ? "unknown"
    : components.every(component => component.status === "operational") ? "operational" : "incident";
  const from = statusTime(start);
  const to = statusTime(end);
  const hasWindow = from != null && to != null && from <= to;
  const incidents = !hasWindow ? [] : (data?.incidents || []).filter(incident => {
    if (!incidentMentionsProvider(incident, provider) || incident.startedAt == null) return false;
    // A resolved event without an end time must not be treated as still active.
    const until = incident.resolved ? incident.resolvedAt : statusTime(data.fetchedAt);
    return until != null && until >= incident.startedAt && incident.startedAt <= to && until >= from;
  });
  return { current, stale, hasWindow, incidents, componentNames: names };
}
