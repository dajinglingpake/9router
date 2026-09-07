import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

const defaultCombos = JSON.parse(
  fs.readFileSync(new URL("../../default-combos.json", import.meta.url), "utf8"),
);

describe("default combos", () => {
  it("routes Codex auto-review through the review quota model", () => {
    const matches = defaultCombos.filter((combo) => combo.name === "codex-auto-review");

    expect(matches).toEqual([
      {
        name: "codex-auto-review",
        models: ["cx/gpt-5.6-sol-review"],
      },
    ]);
  });

  it("routes GPT-6 Astra through Codex", () => {
    const matches = defaultCombos.filter((combo) => combo.name === "gpt-6-astra");

    expect(matches).toEqual([
      {
        name: "gpt-6-astra",
        models: ["cx/gpt-6-astra"],
      },
    ]);
  });

  it("registers GPT-6 Astra in the Codex provider catalog", async () => {
    const codex = (await import("../../open-sse/providers/registry/codex.js")).default;

    expect(codex.models).toContainEqual({
      id: "gpt-6-astra",
      name: "GPT-6 Astra",
    });
  });

  it("uses the official GPT-6 Astra context window", () => {
    expect(getCapabilitiesForModel("codex", "gpt-6-astra")).toMatchObject({
      contextWindow: 1050000,
      maxOutput: 128000,
      thinkingCanDisable: false,
    });
  });

  it("uses the official GPT-6 Astra reasoning efforts", () => {
    expect(getThinkingLevels("codex", "gpt-6-astra")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("exposes Codex Spark models under their standard model IDs", () => {
    const matches = defaultCombos.filter((combo) => combo.name.startsWith("gpt-5.3-codex-spark"));

    expect(matches).toEqual([
      {
        name: "gpt-5.3-codex-spark",
        models: ["cx/gpt-5.3-codex-spark"],
      },
      {
        name: "gpt-5.3-codex-spark-review",
        models: ["cx/gpt-5.3-codex-spark-review"],
      },
    ]);
  });
});
