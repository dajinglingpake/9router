#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PRICING_FILE = path.join(ROOT_DIR, "src/shared/constants/pricing.js");
const execFileAsync = promisify(execFile);

const SOURCES = {
  openai: "https://developers.openai.com/api/docs/pricing",
  anthropic: "https://docs.anthropic.com/en/docs/about-claude/pricing",
  gemini: "https://ai.google.dev/gemini-api/docs/pricing?hl=en",
  deepseek: "https://api-docs.deepseek.com/quick_start/pricing",
  qwen: "https://www.alibabacloud.com/help/en/model-studio/model-pricing",
  kimi: "https://platform.moonshot.ai/",
  glm: "https://open.bigmodel.cn/pricing",
  minimax: "https://platform.minimaxi.com/docs/guides/pricing-paygo",
  xai: "https://docs.x.ai/docs/models/grok-code-fast-1",
};

const FX_URL = "https://open.er-api.com/v6/latest/CNY";
const DEFAULT_CNY_TO_USD = 0.141;

const args = new Set(process.argv.slice(2));
const shouldWrite = args.has("--write");
const explicitRate = process.argv
  .slice(2)
  .find((arg) => arg.startsWith("--cny-usd="))
  ?.split("=")[1];

function usage() {
  console.log(`Usage: node scripts/update-pricing.mjs [--write] [--cny-usd=0.141]

Fetches official pricing pages, refreshes static prices in src/shared/constants/pricing.js,
and converts CNY-denominated official prices to USD per 1M tokens.

Without --write, the script prints the planned updates only.`);
}

if (args.has("--help") || args.has("-h")) {
  usage();
  process.exit(0);
}

function roundPrice(value) {
  if (!Number.isFinite(value)) return value;
  return Number(value.toFixed(value < 1 ? 3 : 2));
}

function pricing({ input, cached, output, reasoning = output, cache_creation = input }) {
  return {
    input: roundPrice(input),
    output: roundPrice(output),
    cached: roundPrice(cached),
    reasoning: roundPrice(reasoning),
    cache_creation: roundPrice(cache_creation),
  };
}

function cnyPricing(rate, values) {
  return pricing({
    input: values.input * rate,
    cached: values.cached * rate,
    output: values.output * rate,
    reasoning: (values.reasoning ?? values.output) * rate,
    cache_creation: (values.cache_creation ?? values.input) * rate,
  });
}

function formatNumber(value) {
  if (Number.isInteger(value)) return `${value}.00`;
  return String(value);
}

function formatPricing(value) {
  return `{ input: ${formatNumber(value.input)}, output: ${formatNumber(value.output)}, cached: ${formatNumber(value.cached)}, reasoning: ${formatNumber(value.reasoning)}, cache_creation: ${formatNumber(value.cache_creation)} }`;
}

function htmlDecode(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(value) {
  return htmlDecode(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

async function fetchText(url) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/json,text/plain",
  };

  try {
    const response = await fetch(url, { headers });
    if (response.ok) return await response.text();
    throw new Error(`${url} returned ${response.status}`);
  } catch (fetchError) {
    try {
      const { stdout } = await execFileAsync("curl", [
        "-L",
        "--max-time", "30",
        "-sS",
        "-A", headers["User-Agent"],
        "-H", `Accept: ${headers.Accept}`,
        url,
      ], { maxBuffer: 20 * 1024 * 1024 });
      if (stdout) return stdout;
    } catch (curlError) {
      try {
        const { stdout } = await execFileAsync("curl", ["-L", "--max-time", "30", "-sS", url], { maxBuffer: 20 * 1024 * 1024 });
        if (stdout) return stdout;
      } catch (plainCurlError) {
        throw new Error(`${fetchError.message}; curl fallback failed: ${curlError.message}; plain curl failed: ${plainCurlError.message}`);
      }
    }
    throw fetchError;
  }
}

async function fetchSources() {
  const entries = await Promise.all(
    Object.entries(SOURCES).map(async ([name, url]) => {
      try {
        return [name, { ok: true, url, text: await fetchText(url) }];
      } catch (error) {
        return [name, { ok: false, url, error: error.message, text: "" }];
      }
    })
  );
  return Object.fromEntries(entries);
}

async function getCnyToUsdRate() {
  if (explicitRate) {
    const parsed = Number(explicitRate);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`Invalid --cny-usd value: ${explicitRate}`);
    }
    return { rate: parsed, source: "cli" };
  }

  try {
    const data = JSON.parse(await fetchText(FX_URL));
    const rate = Number(data?.rates?.USD);
    if (Number.isFinite(rate) && rate > 0) return { rate, source: FX_URL };
  } catch (error) {
    console.warn(`[pricing] Unable to fetch CNY/USD rate: ${error.message}`);
  }

  return { rate: DEFAULT_CNY_TO_USD, source: "fallback" };
}

function assertSource(source, name, keywords) {
  if (!source?.ok) throw new Error(`${name} source fetch failed: ${source?.error || "unknown error"}`);
  for (const keyword of keywords) {
    if (!source.text.includes(keyword)) {
      throw new Error(`${name} source missing keyword: ${keyword}`);
    }
  }
}

function parseOpenAiRow(html, model) {
  const decoded = htmlDecode(html);
  const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const row = decoded.match(new RegExp(`\\[\\[0,"${escaped}"\\],\\[0,([^\\]]+)\\],\\[0,([^\\]]+)\\],\\[0,([^\\]]+)\\]\\]`));
  if (!row) return null;
  const values = row.slice(1).map((raw) => {
    const trimmed = raw.trim().replace(/^"|"$/g, "");
    return trimmed === "-" ? null : Number(trimmed);
  });
  if (!Number.isFinite(values[0]) || !Number.isFinite(values[2])) return null;
  return pricing({ input: values[0], cached: values[1] ?? values[0], output: values[2] });
}

function parseGeminiSection(html, sectionId) {
  const marker = `id="${sectionId}"`;
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const next = html.indexOf('<div class="models-section">', start + marker.length);
  const section = html.slice(start, next === -1 ? undefined : next);

  const firstDollar = (labelPrefix) => {
    const labelRe = new RegExp(`<td>${labelPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^<]*</td>`);
    const matchLabel = section.match(labelRe);
    if (!matchLabel) return null;
    const labelIndex = matchLabel.index;
    const rowEnd = section.indexOf("</tr>", labelIndex);
    const text = stripTags(section.slice(labelIndex, rowEnd));
    const match = text.match(/\$([0-9]+(?:\.[0-9]+)?)/);
    return match ? Number(match[1]) : null;
  };

  const input = firstDollar("Input price");
  const output = firstDollar("Output price (including thinking tokens)");
  const cached = firstDollar("Context caching price");
  if (![input, output, cached].every(Number.isFinite)) return null;
  return pricing({ input, cached, output });
}

function modelUpdate(model, value, sourceName, note = "") {
  return { kind: "model", key: model, value, sourceName, note };
}

function patternUpdate(pattern, value, sourceName, note = "") {
  return { kind: "pattern", key: pattern, value, sourceName, note };
}

function buildUpdates(sources, cnyToUsd) {
  const updates = [];

  assertSource(sources.openai, "OpenAI", ["gpt-5.3-codex", "gpt-5-codex"]);
  for (const model of ["gpt-5", "gpt-5-codex", "gpt-5.3-codex"]) {
    const value = parseOpenAiRow(sources.openai.text, model);
    if (value) updates.push(modelUpdate(model, value, "openai", "parsed"));
  }
  // OpenAI currently exposes these useful aliases in the same pricing page family.
  updates.push(modelUpdate("gpt-5.4", pricing({ input: 2.50, cached: 0.25, output: 15.00 }), "openai", "official static mapping"));
  updates.push(modelUpdate("gpt-5.5", pricing({ input: 5.00, cached: 0.50, output: 30.00 }), "openai", "official static mapping"));

  assertSource(sources.anthropic, "Anthropic", ["Claude", "pricing"]);
  updates.push(modelUpdate("claude-opus-4-20250514", pricing({ input: 15.00, cached: 1.50, output: 75.00, cache_creation: 18.75 }), "anthropic"));
  updates.push(modelUpdate("claude-opus-4.1", pricing({ input: 15.00, cached: 1.50, output: 75.00, cache_creation: 18.75 }), "anthropic"));
  updates.push(modelUpdate("claude-haiku-4.5", pricing({ input: 1.00, cached: 0.10, output: 5.00, cache_creation: 1.25 }), "anthropic"));
  for (const model of ["claude-opus-4.5", "claude-opus-4.6", "claude-opus-4-5-thinking", "claude-opus-4-6-thinking"]) {
    updates.push(modelUpdate(model, pricing({ input: 5.00, cached: 0.50, output: 25.00, cache_creation: 6.25 }), "anthropic"));
  }
  for (const model of ["claude-sonnet-4", "claude-sonnet-4.5", "claude-sonnet-4.6"]) {
    updates.push(modelUpdate(model, pricing({ input: 3.00, cached: 0.30, output: 15.00, cache_creation: 3.75 }), "anthropic"));
  }

  assertSource(sources.gemini, "Gemini", ["Gemini 2.5 Pro", "Gemini 2.5 Flash-Lite"]);
  const gemini25Pro = parseGeminiSection(sources.gemini.text, "gemini-2.5-pro");
  const gemini25FlashLite = parseGeminiSection(sources.gemini.text, "gemini-2.5-flash-lite");
  if (gemini25Pro) updates.push(modelUpdate("gemini-2.5-pro", gemini25Pro, "gemini", "parsed <=200k tier"));
  if (gemini25FlashLite) updates.push(modelUpdate("gemini-2.5-flash-lite", gemini25FlashLite, "gemini", "parsed"));
  const gemini3Flash = pricing({ input: 0.50, cached: 0.05, output: 3.00 });
  for (const model of ["gemini-3-flash-preview", "gemini-3-flash-agent", "gemini-3-flash"]) {
    updates.push(modelUpdate(model, gemini3Flash, "gemini", "official static mapping"));
  }

  assertSource(sources.deepseek, "DeepSeek", ["deepseek-v4-flash", "deepseek-v4-pro"]);
  updates.push(modelUpdate("deepseek-v4-flash", pricing({ input: 0.14, cached: 0.0028, output: 0.28 }), "deepseek"));
  updates.push(modelUpdate("deepseek-v4-pro", pricing({ input: 0.435, cached: 0.003625, output: 0.87 }), "deepseek"));

  assertSource(sources.qwen, "Qwen", ["qwen", "Qwen"]);
  updates.push(modelUpdate("qwen3-coder-plus", pricing({ input: 0.574, cached: 0.115, output: 2.294 }), "qwen", "global <=32k tier"));
  updates.push(modelUpdate("qwen3-coder-flash", pricing({ input: 0.144, cached: 0.029, output: 0.574 }), "qwen", "global <=32k tier"));

  assertSource(sources.kimi, "Kimi", ["Kimi"]);
  updates.push(modelUpdate("kimi-k2.5", pricing({ input: 0.60, cached: 0.10, output: 3.00 }), "kimi"));
  updates.push(modelUpdate("kimi-k2.5-thinking", pricing({ input: 0.60, cached: 0.10, output: 3.00 }), "kimi"));
  updates.push(modelUpdate("kimi-k2.6", pricing({ input: 0.95, cached: 0.16, output: 4.00 }), "kimi"));

  assertSource(sources.glm, "GLM", ["智谱", "大模型"]);
  updates.push(modelUpdate("glm-4.7", cnyPricing(cnyToUsd, { input: 2.00, cached: 0.40, output: 8.00 }), "glm", "CNY converted"));
  updates.push(modelUpdate("glm-5", cnyPricing(cnyToUsd, { input: 4.00, cached: 1.00, output: 18.00 }), "glm", "CNY converted"));

  assertSource(sources.minimax, "MiniMax", ["MiniMax", "M2"]);
  const minimaxM21 = cnyPricing(cnyToUsd, { input: 2.10, cached: 0.21, output: 8.40, cache_creation: 2.625 });
  const minimaxM27 = cnyPricing(cnyToUsd, { input: 2.10, cached: 0.42, output: 8.40, cache_creation: 2.625 });
  for (const model of ["MiniMax-M2.1", "MiniMax-M2.5", "minimax-m2.1", "minimax-m2.5"]) {
    updates.push(modelUpdate(model, minimaxM21, "minimax", "CNY converted"));
  }
  updates.push(modelUpdate("MiniMax-M2.7", minimaxM27, "minimax", "CNY converted"));

  assertSource(sources.xai, "xAI", ["grok-code-fast-1", "grok-build-0.1"]);
  updates.push(modelUpdate("grok-code-fast-1", pricing({ input: 1.00, cached: 0.20, output: 2.00 }), "xai"));

  const patternValues = new Map(updates.filter((u) => u.kind === "model").map((u) => [u.key, u.value]));
  updates.push(patternUpdate("*-codex-spark", patternValues.get("gpt-5.3-codex"), "openai"));
  updates.push(patternUpdate("codex-*", patternValues.get("gpt-5-codex"), "openai"));
  updates.push(patternUpdate("*-codex", patternValues.get("gpt-5-codex"), "openai"));
  updates.push(patternUpdate("gpt-5.5*", patternValues.get("gpt-5.5"), "openai"));
  updates.push(patternUpdate("gpt-5.4*", patternValues.get("gpt-5.4"), "openai"));
  updates.push(patternUpdate("gpt-5.3-codex*", patternValues.get("gpt-5.3-codex"), "openai"));
  updates.push(patternUpdate("gpt-5.3-*", patternValues.get("gpt-5.3-codex"), "openai"));
  updates.push(patternUpdate("gpt-5-*", patternValues.get("gpt-5"), "openai"));
  updates.push(patternUpdate("gpt-5*", patternValues.get("gpt-5"), "openai"));
  updates.push(patternUpdate("gemini-*-flash-lite", patternValues.get("gemini-2.5-flash-lite"), "gemini"));
  updates.push(patternUpdate("gemini-*-pro", patternValues.get("gemini-2.5-pro"), "gemini"));
  updates.push(patternUpdate("gemini-3-flash*", patternValues.get("gemini-3-flash"), "gemini"));
  updates.push(patternUpdate("gemini-3-*", patternValues.get("gemini-3-flash"), "gemini"));
  updates.push(patternUpdate("gemini-*", patternValues.get("gemini-3-flash"), "gemini"));
  updates.push(patternUpdate("qwen3-coder-plus*", patternValues.get("qwen3-coder-plus"), "qwen"));
  updates.push(patternUpdate("qwen3-coder-flash*", patternValues.get("qwen3-coder-flash"), "qwen"));
  updates.push(patternUpdate("qwen3-coder-*", patternValues.get("qwen3-coder-plus"), "qwen"));
  updates.push(patternUpdate("qwen*-coder-*", patternValues.get("qwen3-coder-plus"), "qwen"));
  updates.push(patternUpdate("kimi-k2.6*", patternValues.get("kimi-k2.6"), "kimi"));
  updates.push(patternUpdate("kimi-k2.5*", patternValues.get("kimi-k2.5"), "kimi"));
  updates.push(patternUpdate("kimi-*-thinking", patternValues.get("kimi-k2.5"), "kimi"));
  updates.push(patternUpdate("kimi-k2*", patternValues.get("kimi-k2.5"), "kimi"));
  updates.push(patternUpdate("glm-5*", patternValues.get("glm-5"), "glm"));
  updates.push(patternUpdate("glm-4.7*", patternValues.get("glm-4.7"), "glm"));
  updates.push(patternUpdate("glm-4*", patternValues.get("glm-4.7"), "glm"));
  updates.push(patternUpdate("MiniMax-M2.7*", patternValues.get("MiniMax-M2.7"), "minimax"));
  updates.push(patternUpdate("minimax-m2.7*", patternValues.get("MiniMax-M2.7"), "minimax"));
  updates.push(patternUpdate("MiniMax-*", patternValues.get("MiniMax-M2.5"), "minimax"));
  updates.push(patternUpdate("minimax-*", patternValues.get("minimax-m2.5"), "minimax"));
  updates.push(patternUpdate("grok-code-*", patternValues.get("grok-code-fast-1"), "xai"));
  updates.push(patternUpdate("grok-*", patternValues.get("grok-code-fast-1"), "xai"));

  return updates.filter((update) => update.value);
}

function replaceOrInsertModel(source, key, value) {
  const formatted = `  "${key}": ${formatPricing(value)},`;
  const re = new RegExp(`^\\s*"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*\\{[^}]+\\},`, "m");
  if (re.test(source)) return source.replace(re, formatted);

  const marker = "  // === Misc ===";
  const index = source.indexOf(marker);
  if (index === -1) throw new Error(`Unable to insert model ${key}: marker not found`);
  return `${source.slice(0, index)}${formatted}\n${source.slice(index)}`;
}

function replacePattern(source, key, value) {
  const formatted = `{ pattern: "${key}", pricing: ${formatPricing(value)} }`;
  const re = new RegExp(`\\{\\s*pattern:\\s*"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*,\\s*pricing:\\s*\\{[^}]+\\}\\s*\\}`);
  if (!re.test(source)) throw new Error(`Pattern not found: ${key}`);
  return source.replace(re, formatted);
}

function applyUpdates(source, updates) {
  let next = source;
  for (const update of updates) {
    next = update.kind === "model"
      ? replaceOrInsertModel(next, update.key, update.value)
      : replacePattern(next, update.key, update.value);
  }
  return next;
}

function summarize(updates, cnyRateInfo) {
  console.log(`[pricing] CNY -> USD rate: ${cnyRateInfo.rate} (${cnyRateInfo.source})`);
  console.log(`[pricing] ${shouldWrite ? "Applying" : "Planned"} ${updates.length} updates:`);
  for (const update of updates) {
    const label = update.kind === "model" ? "model" : "pattern";
    const note = update.note ? `, ${update.note}` : "";
    console.log(`  - ${label} ${update.key}: ${formatPricing(update.value)} (${update.sourceName}${note})`);
  }
}

async function main() {
  const [sourceText, sources, cnyRateInfo] = await Promise.all([
    fs.readFile(PRICING_FILE, "utf8"),
    fetchSources(),
    getCnyToUsdRate(),
  ]);

  const updates = buildUpdates(sources, cnyRateInfo.rate);
  const next = applyUpdates(sourceText, updates);

  summarize(updates, cnyRateInfo);
  if (!shouldWrite) {
    console.log("[pricing] Dry run only. Re-run with --write to update the file.");
    return;
  }

  if (next === sourceText) {
    console.log("[pricing] No changes needed.");
    return;
  }

  await fs.writeFile(PRICING_FILE, next, "utf8");
  console.log(`[pricing] Updated ${path.relative(ROOT_DIR, PRICING_FILE)}.`);
}

main().catch((error) => {
  console.error(`[pricing] ${error.message}`);
  process.exit(1);
});
