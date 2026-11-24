import { MODEL_PRICING } from "open-sse/providers/pricing.js";
import { OPENAI_USAGE_CONFIG as config } from "open-sse/providers/registry/openai.js";

export const getOpenAIBaseModel = model => typeof model === "string" ? model.replace(/-\d{4}-\d{2}-\d{2}$/, "") : "";

function getTierMultiplier(model, tier, bucketStartTime) {
  if (tier === "ultrafast") {
    const promotion = config.ultrafastPromotion;
    if (promotion.models.includes(model)) {
      return bucketStartTime < promotion.endTime ? promotion.multiplier : config.tierMultipliers.ultrafast;
    }
    if (!config.ultrafastModels.includes(model)) return null;
  }
  return Object.hasOwn(config.tierMultipliers, tier) ? config.tierMultipliers[tier] : null;
}

// Organization usage is aggregated: short-context prices are an estimate,
// not a bill. Only use verified model/tier prices, never a wildcard fallback.
export function estimateOpenAIUsage(rows) {
  const groups = new Map();
  let unpricedRequests = 0;
  for (const row of rows) {
    const model = getOpenAIBaseModel(row.model);
    const tier = row.batch === true ? "batch" : row.service_tier;
    const multiplier = getTierMultiplier(model, tier, row.bucketStartTime);
    const cached = row.input_cached_tokens ?? 0;
    const write12h = row.input_cache_write_12h_tokens ?? 0;
    const written = row.input_cache_write_tokens ?? ((row.input_cache_write_30m_tokens ?? 0) + write12h);
    const write30m = written - write12h;
    const uncached = row.input_tokens - cached - written;
    const counts = [uncached, cached, write30m, write12h, row.output_tokens];
    const unsupported = !config.estimatedModels.includes(model) || multiplier === null
      // Vision input is included in the model's input tokens at the same rate.
      || ["input_audio_tokens", "input_cached_audio_tokens", "output_audio_tokens", "output_image_tokens"].some(field => (row[field] ?? 0) !== 0)
      || counts.some(count => typeof count !== "number" || !Number.isFinite(count) || count < 0)
      || (row.input_cache_write_30m_tokens != null && row.input_cache_write_30m_tokens !== write30m);
    if (unsupported) {
      unpricedRequests += row.num_model_requests;
      continue;
    }
    const pricing = MODEL_PRICING[model];
    const rates = [pricing.input, pricing.cached, pricing.cache_creation,
      pricing.cache_creation * config.cacheWrite12hMultiplier, pricing.output].map(rate => rate * multiplier);
    const key = JSON.stringify([row.model, tier, multiplier]);
    if (!groups.has(key)) {
      groups.set(key, {
        model: row.model, tier, requests: 0, amount: 0,
        components: ["input", "cached", "write30m", "write12h", "output"].map((type, index) => ({ type, tokens: 0, rate: rates[index], amount: 0 })),
      });
    }
    const group = groups.get(key);
    group.requests += row.num_model_requests;
    counts.forEach((tokens, index) => {
      const amount = tokens * rates[index] / 1_000_000;
      group.components[index].tokens += tokens;
      group.components[index].amount += amount;
      group.amount += amount;
    });
  }
  const breakdown = [...groups.values()];
  return {
    currency: "USD",
    amount: breakdown.length || rows.length === 0 ? breakdown.reduce((total, group) => total + group.amount, 0) : null,
    unpricedRequests, breakdown, pricingUrl: config.pricingUrl,
  };
}
