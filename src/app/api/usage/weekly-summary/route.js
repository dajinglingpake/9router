import { NextResponse } from "next/server";
import { getApiKeys } from "@/lib/localDb";
import { getUsageHistory } from "@/lib/usageDb";

const DEFAULT_DAYS = 7;

function parseDateParam(value, fallback) {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getTokenCount(tokens, ...keys) {
  if (!tokens || typeof tokens !== "object") return 0;
  for (const key of keys) {
    const value = tokens[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function getApiKeyLabel(apiKey, keyMap) {
  if (!apiKey) return "Local (No API Key)";
  return keyMap.get(apiKey)?.name || "Unknown API Key";
}

function createBucket(label, meta = {}) {
  return {
    label,
    ...meta,
    requests: 0,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    cost: 0,
    tokenShare: 0,
    costShare: 0,
  };
}

function addUsage(bucket, entry) {
  const tokens = entry.tokens || {};
  const inputTokens = getTokenCount(tokens, "prompt_tokens", "input_tokens");
  const cachedTokens = getTokenCount(tokens, "cached_tokens", "cache_read_input_tokens");
  const outputTokens = getTokenCount(tokens, "completion_tokens", "output_tokens");
  const reasoningTokens = getTokenCount(tokens, "reasoning_tokens");
  const cacheCreationTokens = getTokenCount(tokens, "cache_creation_input_tokens");

  bucket.requests += 1;
  bucket.inputTokens += inputTokens;
  bucket.cachedTokens += cachedTokens;
  bucket.outputTokens += outputTokens;
  bucket.reasoningTokens += reasoningTokens;
  bucket.cacheCreationTokens += cacheCreationTokens;
  bucket.totalTokens += inputTokens + outputTokens;
  bucket.cost += entry.cost || 0;
}

function applyShares(rows, totals) {
  for (const row of rows) {
    row.tokenShare = totals.totalTokens > 0 ? row.totalTokens / totals.totalTokens : 0;
    row.costShare = totals.cost > 0 ? row.cost / totals.cost : 0;
  }
}

function sortRows(rows) {
  return rows.sort((a, b) => {
    if (b.totalTokens !== a.totalTokens) return b.totalTokens - a.totalTokens;
    if (b.cost !== a.cost) return b.cost - a.cost;
    return String(a.label).localeCompare(String(b.label));
  });
}

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const now = new Date();
    const defaultStart = new Date(now.getTime() - (DEFAULT_DAYS - 1) * 24 * 60 * 60 * 1000);
    defaultStart.setHours(0, 0, 0, 0);

    const startDate = parseDateParam(searchParams.get("startDate") || searchParams.get("since"), defaultStart);
    const endDate = parseDateParam(searchParams.get("endDate") || searchParams.get("until"), now);
    if (!startDate || !endDate) {
      return NextResponse.json({ error: "Invalid startDate or endDate" }, { status: 400 });
    }
    if (startDate > endDate) {
      return NextResponse.json({ error: "startDate must be before endDate" }, { status: 400 });
    }

    const [apiKeys, history] = await Promise.all([
      getApiKeys(),
      getUsageHistory({ startDate: startDate.toISOString(), endDate: endDate.toISOString() }),
    ]);

    const keyMap = new Map(apiKeys.map((key) => [key.key, { id: key.id, name: key.name }]));
    const totals = createBucket("total");
    const byApiKey = new Map();

    for (const entry of history) {
      const keyInfo = keyMap.get(entry.apiKey);
      const apiKeyLabel = getApiKeyLabel(entry.apiKey, keyMap);
      const apiKeyId = keyInfo?.id || null;
      const apiKeyKey = apiKeyId || (entry.apiKey ? "unknown-api-key" : "local-no-key");
      const apiKeyBucket = byApiKey.get(apiKeyKey) || createBucket(apiKeyLabel, {
        apiKeyId,
        apiKeyName: apiKeyLabel,
        hasApiKey: !!entry.apiKey,
      });
      byApiKey.set(apiKeyKey, apiKeyBucket);

      addUsage(totals, entry);
      addUsage(apiKeyBucket, entry);
    }

    const apiKeyRows = sortRows([...byApiKey.values()]);
    applyShares(apiKeyRows, totals);

    return NextResponse.json({
      period: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      },
      totals,
      byApiKey: apiKeyRows,
      recordCount: history.length,
    });
  } catch (error) {
    console.error("[API] Failed to get weekly usage summary:", error);
    return NextResponse.json({ error: "Failed to fetch weekly usage summary" }, { status: 500 });
  }
}
