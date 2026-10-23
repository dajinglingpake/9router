import fs from "node:fs";
import { createRequire } from "node:module";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
let code;
beforeAll(async () => {
  const swc = require("next/dist/build/swc");
  await swc.loadBindings();
  ({ code } = await swc.transform(fs.readFileSync(new URL("../../src/app/(dashboard)/dashboard/providers/[id]/BulkConnectionTimingModal.js", import.meta.url), "utf8"), {
    filename: "BulkConnectionTimingModal.js",
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" },
  }));
});
beforeEach(() => vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true })));
afterEach(() => vi.unstubAllGlobals());

// Exercise the real form handlers without a DOM or requests to live accounts.
function form(connections = [{ id: "selected-a", maxConcurrency: 2 }, { id: "selected-b", maxConcurrency: 7 }]) {
  const states = [];
  let cursor = 0;
  const mod = { exports: {} };
  const props = { connections, onSaved: vi.fn(), onClose: vi.fn() };
  const scopedRequire = name => {
    if (name === "react") return { ...require("react"), useState: initial => {
      const index = cursor++;
      if (!Object.hasOwn(states, index)) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], value => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
    } };
    if (name === "@/shared/components") return { Button: "button", Input: "input", Modal: "dialog" };
    if (name === "@/i18n/runtime") return { translate: text => text };
    return require(name);
  };
  new Function("require", "module", "exports", code)(scopedRequire, mod, mod.exports);
  const walk = node => Array.isArray(node) ? node.flatMap(walk)
    : node?.props ? [node, ...walk(node.props.children)] : [];
  const nodes = () => { cursor = 0; return walk(mod.exports.default(props)); };
  return {
    ...props,
    input: label => nodes().find(node => node.props["aria-label"] === label),
    check: index => nodes().filter(node => node.type === "input" && node.props.type === "checkbox")[index].props.onChange({ target: { checked: true } }),
    set: (label, value) => nodes().find(node => node.props["aria-label"] === label).props.onChange({ target: { value } }),
    submit: () => nodes().find(node => node.type === "form").props.onSubmit({ preventDefault() {} }),
    submitButton: () => nodes().find(node => node.type === "button" && node.props.type === "submit"),
    error: () => nodes().find(node => node.props.role === "alert")?.props.children,
  };
}

describe("bulk connection settings", () => {
  it("requires opting in and leaves mixed concurrency values blank", () => {
    const ui = form();
    expect(ui.input("Max concurrent requests").props).toMatchObject({ value: "", disabled: true });
    expect(ui.submitButton().props.disabled).toBe(true);
    ui.check(0);
    expect(ui.input("Max concurrent requests").props.disabled).toBe(false);
    expect(ui.submitButton().props.disabled).toBe(false);
  });

  it.each([0, 2, 1000])("applies concurrency %s only to the selected accounts and preserves other settings", async value => {
    const ui = form();
    ui.check(0);
    ui.set("Max concurrent requests", String(value));
    await ui.submit();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/providers/selected-a", "/api/providers/selected-b"]);
    for (const [, request] of fetch.mock.calls) {
      expect(request.method).toBe("PUT");
      expect(JSON.parse(request.body)).toEqual({ maxConcurrency: value });
    }
    expect(ui.onSaved).toHaveBeenCalledOnce();
    expect(ui.onClose).toHaveBeenCalledOnce();
  });

  it.each(["", "1.5", "-1", "1001", "invalid"])("rejects invalid concurrency %s before updating any account", async value => {
    const ui = form();
    ui.check(0);
    ui.set("Max concurrent requests", value);
    await ui.submit();
    expect(fetch).not.toHaveBeenCalled();
    expect(ui.error()).toContain("Enter an integer between 0 and 1000.");
  });

  it("keeps concurrency unchanged when only request intervals are checked", async () => {
    const ui = form();
    ui.check(1);
    ui.set("Request interval minimum (seconds)", "1.5");
    ui.set("Request interval maximum (seconds)", "2.5");
    await ui.submit();
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [, request] of fetch.mock.calls) {
      expect(JSON.parse(request.body)).toEqual({ minRequestIntervalMs: 1500, maxRequestIntervalMs: 2500 });
    }
  });

  it("reports partial failures and keeps the dialog open", async () => {
    fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "not saved" }) });
    const ui = form();
    ui.check(0);
    ui.set("Max concurrent requests", "1");
    await ui.submit();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(ui.onSaved).toHaveBeenCalledOnce();
    expect(ui.onClose).not.toHaveBeenCalled();
    expect(ui.error()).toBe("Saved: 1; failed: 1");
  });
});
