import { calculateCostFromTokens, getPricingForModel } from "open-sse/providers/pricing.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

// These Kimi Code IDs had no default price. Repair only their zero-cost rows;
// user-defined prices (including intentional zero rates) take precedence.
export default {
  version: 2,
  name: "kimi-code-pricing",
  up(db) {
    const custom = parseJson(db.get("SELECT value FROM kv WHERE scope = 'pricing' AND key = 'kimi'")?.value, {}) || {};
    const rows = db.all(`SELECT * FROM usageHistory
      WHERE provider = 'kimi' AND model IN ('k3.1-pro', 'k3.1-pro-highspeed', 'k3-256k') AND cost = 0`);
    const days = new Map();

    for (const row of rows) {
      if (Object.hasOwn(custom, row.model)) continue;
      const tokens = parseJson(row.tokens, {}) || {};
      const cost = calculateCostFromTokens({
        ...tokens,
        prompt_tokens: tokens.prompt_tokens ?? row.promptTokens,
        completion_tokens: tokens.completion_tokens ?? row.completionTokens,
        // Older Responses usage dropped the nested details. Kimi still counted
        // thinking in completion_tokens, so restore that fact for pricing only.
        completion_tokens_details: tokens.completion_tokens_details ?? { reasoning_tokens: tokens.reasoning_tokens || 0 },
      }, getPricingForModel(row.provider, row.model));
      if (!(cost > 0)) continue;

      db.run("UPDATE usageHistory SET cost = ? WHERE id = ?", [cost, row.id]);
      const date = new Date(row.timestamp);
      const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      if (!days.has(dateKey)) {
        days.set(dateKey, parseJson(db.get("SELECT data FROM usageDaily WHERE dateKey = ?", [dateKey])?.data, null));
      }
      const day = days.get(dateKey);
      if (!day) continue;

      // Add only the missing cost. Keep request/token counts and all other
      // providers intact, including daily data older than retained history.
      const apiKey = row.apiKey || "local-no-key";
      const modelKey = `${row.model}|${row.provider}`;
      const buckets = [
        day,
        day.byProvider?.[row.provider],
        day.byModel?.[modelKey],
        day.byAccount?.[row.connectionId],
        day.byApiKey?.[`${apiKey}|${modelKey}`],
        day.byClientIp?.[`${row.clientIp || "unknown"}|${apiKey}|${modelKey}`],
        day.byEndpoint?.[`${row.endpoint || "Unknown"}|${modelKey}`],
      ];
      for (const bucket of buckets) {
        if (bucket) bucket.cost = (bucket.cost || 0) + cost;
      }
    }

    for (const [dateKey, day] of days) {
      if (day) db.run("UPDATE usageDaily SET data = ? WHERE dateKey = ?", [stringifyJson(day), dateKey]);
    }
  },
};
