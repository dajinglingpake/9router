import fs from "node:fs";
import { createRequire } from "node:module";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as trial from "@/shared/utils/codexTrial";
import * as quality from "@/shared/utils/codexTrialQuality";

const require = createRequire(import.meta.url);
let code;
beforeAll(async () => {
  const swc = require("next/dist/build/swc");
  await swc.loadBindings();
  ({ code } = await swc.transform(fs.readFileSync(new URL("../../src/app/(dashboard)/dashboard/diagnostics/CodexTrialsPanel.js", import.meta.url), "utf8"), {
    filename: "CodexTrialsPanel.js",
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" },
  }));
});
afterEach(() => vi.unstubAllGlobals());

function panel(status = "success") {
  const result = { id: "deepseek-result", runId: "current-run", model: "deepseek-v4.1-flash", effort: "max", status, routerStatsVersion: 3 };
  const data = {
    cli: { available: true }, running: ["queued", "running"].includes(status), stopping: false,
    providers: [
      { id: "codex", name: "Codex", defaultModel: "gpt-6.1-sol", models: [{ id: "gpt-6.1-sol", connectionIds: [] }] },
      { id: "codebuddy-cn", name: "CodeBuddy", defaultModel: result.model, models: [{ id: result.model }] },
    ],
    accounts: [{ id: "buddy-account", name: "Account 1", provider: "codebuddy-cn", providerName: "CodeBuddy", enabled: true, results: [result], result }],
  };
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => ({ ok: true, json: async () => options?.method === "POST" ? {} : data })));
  const states = [];
  let cursor = 0;
  const mod = { exports: {} };
  const scopedRequire = name => {
    if (name === "react") return { ...require("react"), useEffect: () => {}, useCallback: fn => fn, useRef: value => ({ current: value }), useState: initial => {
      const index = cursor++;
      if (!Object.hasOwn(states, index)) states[index] = index === 0 ? data : initial;
      return [states[index], value => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
    } };
    if (name === "react/jsx-runtime") return require(name);
    if (name === "./OfficialStatus") return { AccountOfficialStatus: "official-status" };
    if (name === "./CodexTrialModels") return { default: "trial-models", __esModule: true, trialDefaultEffort: () => "" };
    if (name === "@/shared/utils/codexTrial") return trial;
    if (name === "@/shared/utils/codexTrialQuality") return quality;
    if (name === "@/shared/utils/codexTrialOutput") return { formatTrialErrorLog: () => "", formatTrialLog: () => "" };
    if (name === "@/shared/components/Modal") return { __esModule: true, default: "dialog", ConfirmModal: "confirm-dialog" };
    if (name === "@/shared/components/Button") return "button";
    return name;
  };
  new Function("require", "module", "exports", code)(scopedRequire, mod, mod.exports);
  const walk = node => Array.isArray(node) ? node.flatMap(walk)
    : node?.props ? typeof node.type === "function" ? walk(node.type(node.props)) : [node, ...walk(node.props.children)] : [];
  const nodes = () => { cursor = 0; return walk(mod.exports.default()); };
  return {
    result, data,
    button: label => nodes().find(node => node.type === "button" && node.props.children === label),
    selectModels: models => nodes().find(node => node.type === "trial-models").props.onChange(models),
  };
}

describe("account trial controls", () => {
  it("retests a historical model while the top form selects another provider", async () => {
    const ui = panel();
    expect(ui.button("重测此模型").props.disabled).toBe(false);
    await ui.button("重测此模型").props.onClick();
    const [url, options] = fetch.mock.calls.find(([, options]) => options?.method === "POST");
    expect(url).toBe("/api/codex-trials");
    expect(JSON.parse(options.body)).toMatchObject({ ids: ["buddy-account"], models: [{ provider: "codebuddy-cn", model: "deepseek-v4.1-flash", effort: "max" }] });
  });
  it("does not disable a historical retest when the top model selection is empty", () => {
    const ui = panel();
    ui.selectModels([{ provider: "codex", model: "", effort: "" }]);
    expect(ui.button("重测此模型").props.disabled).toBe(false);
  });
  it.each(["running", "queued"])("targets only the displayed %s run when stopping", async status => {
    const ui = panel(status);
    const button = ui.button(status === "queued" ? "取消排队" : "停止此测试");
    expect(button.props.disabled).toBeFalsy();
    expect(ui.button("重测此模型").props.disabled).toBe(true);
    await button.props.onClick();
    const [url, options] = fetch.mock.calls.find(([, options]) => options?.method === "POST");
    expect(url).toBe("/api/codex-trials/deepseek-result");
    expect(JSON.parse(options.body)).toEqual({ action: "stop", runId: "current-run" });
  });
});
