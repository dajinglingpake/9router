import fs from "node:fs";
import { describe, expect, it } from "vitest";
import codex from "../../open-sse/providers/registry/codex.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

const defaultCombos = JSON.parse(fs.readFileSync(new URL("../../default-combos.json", import.meta.url), "utf8"));

describe("GPT-6.1 Sol on Codex", () => {
  it("registers an independent model and default combo without replacing GPT-6 Sol", () => {
    expect(codex.models).toContainEqual({ id: "gpt-6.1-sol", name: "GPT 6.1 Sol" });
    expect(defaultCombos.filter(({ name }) => name === "gpt-6.1-sol")).toEqual([
      { name: "gpt-6.1-sol", models: ["cx/gpt-6.1-sol"] },
    ]);
    expect(defaultCombos).toContainEqual({ name: "gpt-6-sol", models: ["cx/gpt-6-sol"] });
  });

  it("uses the official context, reasoning efforts, and standard token prices", () => {
    expect(getCapabilitiesForModel("codex", "gpt-6.1-sol")).toMatchObject({
      vision: true, reasoning: true, thinkingCanDisable: false,
      contextWindow: 1050000, maxOutput: 128000,
    });
    expect(getThinkingLevels("codex", "gpt-6.1-sol")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(getPricingForModel("codex", "gpt-6.1-sol")).toMatchObject({
      input: 2, cached: 0.1, cache_creation: 2.5, output: 10,
    });
  });

  it.each(["none", "minimal", "max"])("forwards the model with supported reasoning for %s", (effort) => {
    const body = new CodexExecutor().transformRequest("gpt-6.1-sol", {
      model: "gpt-6.1-sol", input: "hi", reasoning_effort: effort,
    }, true, {});
    expect(body.model).toBe("gpt-6.1-sol");
    expect(body.reasoning.effort).toBe(effort === "max" ? "max" : "low");
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
  });
});
