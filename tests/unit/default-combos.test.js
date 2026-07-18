import fs from "node:fs";
import { describe, expect, it } from "vitest";

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
});
