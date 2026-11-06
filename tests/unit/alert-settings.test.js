import fs from "node:fs";
import { createRequire } from "node:module";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ settings: {}, check: vi.fn() }));
vi.mock("@/lib/db/repos/settingsRepo.js", () => ({
  getSettings: async () => mocks.settings,
  updateSettings: async updates => Object.assign(mocks.settings, updates),
}));
vi.mock("@/lib/alerts/monitor.js", () => ({ checkAccountAlerts: mocks.check }));
vi.mock("@/lib/alerts/wecom.js", () => ({ getAlertStatus: async () => ({}), queueAlert: vi.fn() }));

import * as alertConfig from "@/lib/alerts/config.js";
import { GET, PATCH } from "@/app/api/settings/alerts/route.js";

const require = createRequire(import.meta.url);
const webhookUrl = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test";
let componentCode;

beforeAll(async () => {
  const swc = require("next/dist/build/swc");
  await swc.loadBindings();
  ({ code: componentCode } = await swc.transform(fs.readFileSync(new URL("../../src/app/(dashboard)/dashboard/profile/AlertSettings.js", import.meta.url), "utf8"), {
    filename: "AlertSettings.js",
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" },
  }));
});

beforeEach(() => {
  mocks.settings = { wecomAlerts: { enabled: true, webhookUrl } };
  mocks.check.mockReset();
  vi.stubGlobal("fetch", vi.fn((url, options) => options?.method === "PATCH"
    ? PATCH(new Request(`http://localhost${url}`, options)) : GET()));
});
afterEach(() => vi.unstubAllGlobals());

function form() {
  const states = [], effects = [];
  let cursor = 0;
  const mod = { exports: {} };
  const scopedRequire = name => {
    if (name === "react") return { ...require("react"), useEffect: effect => { if (!effects.length) effects.push(effect); }, useState: initial => {
      const index = cursor++;
      if (!Object.hasOwn(states, index)) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], value => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
    } };
    if (name === "@/shared/components") return { Card: "article", Input: "input", Button: "button", Toggle: "toggle", Select: "select" };
    if (name === "@/lib/alerts/config") return alertConfig;
    if (name === "@/shared/hooks/useCopyToClipboard") return { useCopyToClipboard: () => ({ copied: false, copy: vi.fn() }) };
    return require(name);
  };
  new Function("require", "module", "exports", componentCode)(scopedRequire, mod, mod.exports);
  const walk = node => Array.isArray(node) ? node.flatMap(walk) : node?.props ? [node, ...walk(node.props.children)] : [];
  const nodes = () => { cursor = 0; return walk(mod.exports.default()); };
  nodes();
  return {
    load: async () => { effects[0](); await new Promise(resolve => setImmediate(resolve)); },
    toggle: label => nodes().find(node => node.type === "toggle" && node.props.label === label),
    input: label => nodes().find(node => node.type === "input" && node.props.label === label),
    save: () => nodes().find(node => node.type === "button" && node.props.children === "保存").props.onClick(),
  };
}

describe("alert settings", () => {
  it("keeps all alert types enabled for existing configurations", async () => {
    const result = await (await GET()).json();
    for (const type of alertConfig.ALERT_TYPES) expect(result[`${type}Enabled`]).toBe(true);
  });

  it("preserves other switches and the webhook when applying partial updates", async () => {
    for (const update of [{ quotaEnabled: false }, { expiryEnabled: false }]) {
      const response = await PATCH(new Request("http://localhost/api/settings/alerts", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(update),
      }));
      expect(response.status).toBe(200);
      expect(await response.json()).not.toHaveProperty("webhookUrl");
    }
    expect(mocks.settings.wecomAlerts).toMatchObject({ quotaEnabled: false, expiryEnabled: false, authEnabled: true, webhookUrl });
    expect(await (await GET()).json()).toMatchObject({ quotaEnabled: false, expiryEnabled: false, authEnabled: true });
  });

  it("saves individual switches and restores them after reloading the form", async () => {
    const ui = form();
    await ui.load();
    ui.toggle("额度不足或用尽").props.onChange(false);
    ui.toggle("账号或订阅到期").props.onChange(false);
    expect(ui.input("额度剩余 ≤ (%)").props.disabled).toBe(true);
    expect(ui.input("到期前提醒（天）").props.disabled).toBe(true);
    expect(ui.input("余额 ≤（账户币种）").props.disabled).toBe(false);
    await ui.save();
    expect(mocks.settings.wecomAlerts).toMatchObject({
      quotaEnabled: false, expiryEnabled: false, balanceEnabled: true,
      authEnabled: true, networkEnabled: true, overloadEnabled: true, webhookUrl,
    });
    expect(mocks.check).toHaveBeenCalledOnce();
    const reloaded = form();
    await reloaded.load();
    expect(reloaded.toggle("额度不足或用尽").props.checked).toBe(false);
    expect(reloaded.toggle("账号或订阅到期").props.checked).toBe(false);
    expect(reloaded.toggle("DeepSeek 余额不足").props.checked).toBe(true);
  });

  it.each(alertConfig.ALERT_TYPES)("rejects a non-boolean %s setting without updating configuration", async type => {
    const request = new Request("http://localhost/api/settings/alerts", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [`${type}Enabled`]: "false" }),
    });
    expect((await PATCH(request)).status).toBe(400);
    expect(mocks.settings.wecomAlerts).toEqual({ enabled: true, webhookUrl });
    expect(mocks.check).not.toHaveBeenCalled();
  });
});
