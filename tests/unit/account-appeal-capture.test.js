import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppealCollector, installAppealCapture, normalizeAppealMessage } from "@/lib/accountAppeals/capture.mjs";

const item = (id = "message-one", type = "assistant_message", text = "已收到您的反馈") => ({ id, thread_id: "thread-one", type, created_at: "2026-10-20T01:00:00Z", content: [{ type: type === "user_message" ? "input_text" : "output_text", text }] });
afterEach(() => vi.unstubAllGlobals());

describe("appeal message capture", () => {
  it("retains only displayable messages and excludes credentials and tool payloads", () => {
    const message = normalizeAppealMessage({ ...item(), accessToken: "secret", metadata: { authorization: "secret" }, content: [...item().content, { type: "tool_call", text: "private-tool" }] });
    expect(message.text).toBe("已收到您的反馈");
    expect(JSON.stringify(message)).not.toMatch(/secret|private-tool|metadata/);
    expect(normalizeAppealMessage({ ...item(), type: "client_tool_call" })).toBeNull();
    expect(normalizeAppealMessage({ ...item(), thread_id: "../../other" })).toBeNull();
  });

  it("assembles streaming replies and replaces partial text with the final server message", () => {
    const messages = [], capture = createAppealCollector(message => messages.push(message));
    capture({ payload: { type: "thread.item.added", item: { ...item(), content: [] } } });
    capture({ threadId: "thread-one", payload: { type: "thread.item.updated", item_id: "message-one", update: { type: "assistant_message.content_part.added", content_index: 0, content: { type: "output_text", text: "已收到" } } } });
    capture({ threadId: "thread-one", payload: { type: "thread.item.updated", item_id: "message-one", update: { type: "assistant_message.content_part.text_delta", content_index: 0, delta: "反馈" } } });
    expect(messages.at(-1)).toMatchObject({ threadId: "thread-one", text: "已收到反馈", complete: false });
    capture({ payload: { type: "thread.item.done", item: item() } });
    expect(messages.at(-1)).toMatchObject({ text: "已收到您的反馈", complete: true });
  });

  it("imports loaded history and keeps simultaneous threads separate", () => {
    const messages = [], capture = createAppealCollector(message => messages.push(message));
    capture({ requestType: "threads.get_by_id", payload: { id: "thread-one", items: { data: [item("u", "user_message", "请帮我检查")] } } });
    capture({ requestType: "items.list", threadId: "thread-two", payload: { data: [{ ...item("s"), thread_id: undefined }] } });
    expect(messages.map(message => message.threadId)).toEqual(["thread-one", "thread-two"]);
    expect(messages[0]).toMatchObject({ role: "user", complete: true });
    capture({ requestType: "threads.create", payload: { error: "request rejected" } });
    expect(messages).toHaveLength(2);
  });

  it("marks oversized messages as truncated", () => {
    const message = normalizeAppealMessage(item("long", "assistant_message", "a".repeat(100001)));
    expect(message.text).toHaveLength(100000);
    expect(message.truncated).toBe(true);
  });

  async function intercept(response, { verified = true, url = "https://support.api.openai.com/api/v1/chatkit" } = {}) {
    const packets = [];
    const original = vi.fn().mockResolvedValue(response);
    const window = { fetch: original, __nineRouterAppealAccount: verified ? "user@example.com" : null, __nineRouterAppealCapture: packet => packets.push(JSON.parse(packet)) };
    vi.stubGlobal("window", window); vi.stubGlobal("location", { hostname: "help.openai.com", href: "https://help.openai.com/zh-hans-cn" });
    installAppealCapture();
    const returned = await window.fetch(url, { method: "POST", headers: { Authorization: "Bearer private" }, body: JSON.stringify({ type: "threads.create", params: { input: { text: "unsent draft" } } }) });
    return { packets, returned };
  }

  it("captures SSE across chunk boundaries without consuming the real response or recording request drafts", async () => {
    const events = [{ type: "thread.created", thread: { id: "thread-one" } }, { type: "thread.item.done", item: { ...item(), thread_id: undefined } }];
    const source = events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join("");
    const bytes = new TextEncoder().encode(source);
    const response = new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
    const { packets, returned } = await intercept(response);
    expect(await returned.text()).toBe(source);
    await vi.waitFor(() => expect(packets).toHaveLength(2));
    expect(packets[1].threadId).toBe("thread-one");
    expect(JSON.stringify(packets)).not.toMatch(/private|unsent draft/);
  });

  it("supports native Request objects even after the original fetch consumes their bodies", async () => {
    const packets = [];
    const window = { __nineRouterAppealAccount: "user@example.com", __nineRouterAppealCapture: packet => packets.push(JSON.parse(packet)),
      fetch: async input => { await input.text(); return Response.json({ id: "thread-one", items: { data: [item()] } }); } };
    vi.stubGlobal("window", window); vi.stubGlobal("location", { hostname: "help.openai.com", href: "https://help.openai.com/zh-hans-cn" });
    installAppealCapture();
    await window.fetch(new Request("https://support.api.openai.com/api/v1/chatkit", { method: "POST", body: JSON.stringify({ type: "threads.get_by_id", params: { thread_id: "thread-one" } }) }));
    await vi.waitFor(() => expect(packets).toHaveLength(1));
    expect(packets[0]).toMatchObject({ requestType: "threads.get_by_id", threadId: "thread-one" });
  });

  it.each([{ verified: false }, { url: "https://unrelated.example/api/v1/chatkit" }, { status: 500 }])("does not record unverified, unrelated or failed requests: %j", async options => {
    const { packets, returned } = await intercept(Response.json({ data: [item()] }, { status: options.status || 200 }), options);
    await returned.text(); await new Promise(resolve => setTimeout(resolve, 10));
    expect(packets).toEqual([]);
  });
});
