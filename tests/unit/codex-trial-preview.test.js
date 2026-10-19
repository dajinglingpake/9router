import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { trialPreviewDocument } from "@/shared/utils/codexTrial.js";

function preview({ overflow = "visible", readyState = "loading", fonts = Promise.resolve() } = {}) {
  const events = new EventTarget();
  const messages = [];
  const resizeObservers = [];
  const document = { readyState, fonts: { ready: fonts },
    documentElement: { scrollWidth: 1416, scrollHeight: 1052 },
    body: { scrollWidth: 1416, scrollHeight: 1052 } };
  const context = { document, innerWidth: 1280, innerHeight: 800,
    getComputedStyle: () => ({ overflowX: overflow, overflowY: overflow }),
    addEventListener: events.addEventListener.bind(events),
    parent: { postMessage: message => messages.push(message) },
    ResizeObserver: class { constructor(callback) { resizeObservers.push(callback); } observe() {} },
  };
  const html = trialPreviewDocument("<html><body><main>Artwork</main></body></html>");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, context);
  return { events, messages, document, context, resizeObservers };
}

describe("Codex trial preview sizing", () => {
  it.each(["hidden", "clip"])("ignores decorative overflow intentionally clipped by the artwork (%s)", async overflow => {
    const { events, messages } = preview({ overflow });
    events.dispatchEvent(new Event("load"));
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toEqual({ type: "9router-codex-preview-size", width: 1280, height: 800 });
  });

  it("fits genuine overflow once without feeding the resized viewport back into measurements", async () => {
    const { events, messages, document, context, resizeObservers } = preview();
    events.dispatchEvent(new Event("load"));
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toMatchObject({ width: 1416, height: 1052 });
    // Applying that size changes vh/% layout and produces yet more overflow.
    Object.assign(context, { innerWidth: 1416, innerHeight: 1052 });
    Object.assign(document.documentElement, { scrollWidth: 1600, scrollHeight: 1400 });
    Object.assign(document.body, { scrollWidth: 1600, scrollHeight: 1400 });
    resizeObservers.forEach(callback => callback());
    events.dispatchEvent(new Event("resize"));
    events.dispatchEvent(new Event("load"));
    await Promise.resolve();
    expect(messages).toHaveLength(1);
  });

  it("waits for layout fonts and also handles an already loaded document", async () => {
    let finishFonts;
    const fonts = new Promise(resolve => { finishFonts = resolve; });
    const { messages, document } = preview({ readyState: "complete", fonts });
    expect(messages).toEqual([]);
    document.body.scrollHeight = 1200;
    finishFonts();
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toMatchObject({ width: 1416, height: 1200 });
  });
});
