import gemini from "open-sse/providers/registry/gemini.js";
import { getAdapter } from "./db/driver.js";
import { geminiReceiptScope } from "./db/repos/geminiQuotaRepo.js";
import { defaultGeminiLimits, geminiQuotaDefaults, geminiQuotaOverrides } from "./geminiQuotaLimits.js";
import { geminiProjectQuotaUrl } from "./geminiPricing";

const zone = "America/Los_Angeles";
const pacificDate = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
const pacificHour = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "2-digit", hourCycle: "h23" });

// 08:00 UTC is midnight or 01:00 in Los Angeles, including on DST transition days.
function startOfQuotaDay(now) {
  const atEight = new Date(pacificDate.format(now) + "T08:00:00Z");
  return new Date(atEight.getTime() - Number(pacificHour.format(atEight)) * 3600000).toISOString();
}

export function parseGeminiQuota(body) {
  const model = typeof body?.model === "string" ? body.model.trim().replace(/^(?:gemini|models)\//, "") : "";
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(model)) return null;
  if (Object.hasOwn(body, "metric")) {
    const { metric, limit } = body;
    if (Object.hasOwn(body, "limits") || !["rpm", "tpm", "rpd"].includes(metric)) return null;
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 0)) return null;
    return { model, limits: { [metric]: limit }, partial: true };
  }
  if (!body.limits || typeof body.limits !== "object" || Array.isArray(body.limits)) return null;
  const limits = {};
  for (const [key, value] of Object.entries(body.limits)) {
    if (!["rpm", "tpm", "rpd"].includes(key) || !Number.isSafeInteger(value) || value < 0) return null;
    limits[key] = value;
  }
  return { model, limits };
}

export async function getLocalGeminiUsage(connection, now = new Date()) {
  const db = await getAdapter();
  const day = startOfQuotaDay(now);
  const minute = new Date(now.getTime() - 60000).toISOString();
  const settings = connection.providerSpecificData || {};
  const limits = settings.geminiQuotaLimits || {};
  const snapshot = settings.geminiQuotaSnapshot;
  const asOf = now.toISOString();
  const useDailySnapshot = snapshot?.observedAt >= day && snapshot.observedAt <= asOf;
  const from = minute < day ? minute : day;
  const scope = geminiReceiptScope(db, connection.id, now);
  const rows = db.all(`WITH samples AS (
    SELECT model, timestamp, CASE WHEN json_valid(tokens) THEN tokens ELSE '{}' END AS counts,
      CASE WHEN json_extract(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END, '$.geminiQuotaRecorded') = 1 THEN 0 ELSE 1 END AS requests
    FROM usageHistory WHERE provider = 'gemini' AND connectionId = ? AND timestamp BETWEEN ? AND ?
    UNION ALL
    SELECT substr(key, instr(key, '/') + 1), substr(key, 1, instr(key, '/') - 1), '{}', CAST(value AS INTEGER)
    FROM kv WHERE scope = ? AND key >= ? AND key < ?)
    SELECT model, SUM(CASE WHEN timestamp > ? THEN requests ELSE 0 END) AS rpm,
      SUM(CASE WHEN timestamp > ? THEN COALESCE(json_extract(counts, '$.prompt_tokens'), json_extract(counts, '$.input_tokens'), 0) ELSE 0 END) AS tpm,
      SUM(CASE WHEN timestamp >= ? THEN requests ELSE 0 END) AS rpd,
      SUM(CASE WHEN timestamp > ? THEN requests ELSE 0 END) AS sinceCheck,
      SUM(CASE WHEN timestamp >= ? THEN COALESCE(json_extract(counts, '$.prompt_tokens'), json_extract(counts, '$.input_tokens'), 0) ELSE 0 END) AS inputTokens,
      SUM(CASE WHEN timestamp >= ? THEN COALESCE(json_extract(counts, '$.completion_tokens'), json_extract(counts, '$.output_tokens'), 0) ELSE 0 END) AS outputTokens
    FROM samples GROUP BY model ORDER BY rpd DESC, model`,
  [connection.id, from, asOf, scope, from, new Date(now.getTime() + 1).toISOString(), minute, minute, day, useDailySnapshot ? snapshot.observedAt : asOf, day, day]);
  const usage = new Map(rows.map(row => [row.model, row]));
  for (const model of new Set([...Object.keys(geminiQuotaDefaults), ...Object.keys(limits), ...Object.keys(snapshot?.models || {})])) {
    if (!usage.has(model)) usage.set(model, { model, rpm: 0, tpm: 0, rpd: 0, sinceCheck: 0, inputTokens: 0, outputTokens: 0 });
  }
  const models = [...usage.values()].map(({ sinceCheck, ...row }) => {
    const officialUsed = snapshot?.models?.[row.model]?.rpd?.used;
    const estimatedRpd = useDailySnapshot && Number.isSafeInteger(officialUsed)
      ? Math.max(row.rpd, officialUsed + sinceCheck) : row.rpd;
    const defaultLimits = defaultGeminiLimits(row.model);
    const overrides = geminiQuotaOverrides(row.model, limits[row.model]);
    return { ...row, estimatedRpd, limits: { ...defaultLimits, ...overrides }, defaultLimits };
  });
  const detailUrl = geminiProjectQuotaUrl(snapshot?.projectId) || gemini.display.quotaNotice.detailUrl;
  return {
    detailUrl,
    geminiUsage: { asOf, dayStart: day, models, snapshot: snapshot || null, useDailySnapshot },
  };
}
