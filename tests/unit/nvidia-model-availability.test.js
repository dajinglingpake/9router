import { describe, expect, it } from "vitest";
import { parseNvidiaModels } from "@/shared/utils/nvidiaModels";
import { runModelTestBatch } from "@/shared/hooks/useModelTests";

describe("NVIDIA model availability", () => {
  it("keeps the live catalog without retired seeds, duplicates or non-chat misclassification", () => {
    const models = parseNvidiaModels({ data: [
      { id: "minimaxai/minimax-m3.1-flash", privateField: "hidden" },
      { id: "nvidia/nemotron-3.5-embed-8b" },
      { id: "nvidia/nemotron-3.5-rerank-8b" },
      { id: "nvidia/nemotron-4-340b-reward" },
      { id: "minimaxai/minimax-m3.1-flash" }, null, { id: " " },
    ] });
    expect(models.map(model => [model.id, model.kind])).toEqual([
      ["minimaxai/minimax-m3.1-flash", "llm"],
      ["nvidia/nemotron-3.5-embed-8b", "embedding"],
      ["nvidia/nemotron-3.5-rerank-8b", "rerank"],
      ["nvidia/nemotron-4-340b-reward", "reward"],
    ]);
    expect(JSON.stringify(models)).not.toContain("privateField");
    expect(parseNvidiaModels({ data: {} })).toEqual([]);
  });

  it("automatically tests every model with at most two probes in flight", async () => {
    let active = 0;
    let peak = 0;
    const tested = [];
    const progress = [];
    await runModelTestBatch(["a", "b", "c", "d", "e"], async id => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 1));
      tested.push(id);
      active--;
    }, () => false, completed => progress.push(completed));
    expect(tested.sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(peak).toBe(2);
    expect(progress).toEqual([1, 2, 3, 4, 5]);
  });

  it("stops scheduling new models while preserving completed in-flight probes", async () => {
    let stopped = false;
    const pending = [];
    const tested = [];
    const progress = [];
    const batch = runModelTestBatch(["a", "b", "c", "d"], id => {
      tested.push(id);
      return new Promise(resolve => pending.push(resolve));
    }, () => stopped, completed => progress.push(completed));
    expect(tested).toEqual(["a", "b"]);
    stopped = true;
    pending.forEach(resolve => resolve());
    await batch;
    expect(tested).toEqual(["a", "b"]);
    expect(progress).toEqual([1, 2]);
  });

});
