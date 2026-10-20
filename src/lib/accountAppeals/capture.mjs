// Runs in the isolated Help Center page before its scripts load.
export function installAppealCapture() {
  if (location.hostname !== "help.openai.com" || window.__nineRouterAppealCaptureInstalled) return;
  window.__nineRouterAppealCaptureInstalled = true;
  const originalFetch = window.fetch;
  const report = packet => {
    if (window.__nineRouterAppealAccount) window.__nineRouterAppealCapture?.(JSON.stringify(packet));
  };
  window.fetch = async function(input, init) {
    const account = window.__nineRouterAppealAccount;
    let body;
    try {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href);
      if (account && url.origin === "https://support.api.openai.com" && url.pathname === "/api/v1/chatkit") {
        // Clone before fetch consumes Request bodies; ChatKit may use either fetch signature.
        body = typeof init?.body === "string" ? Promise.resolve(init.body) : input instanceof Request ? input.clone().text().catch(() => null) : null;
      }
    } catch { /* Ignore unrelated requests. */ }
    const response = await originalFetch.call(this, input, init);
    try {
      if (!body || !response.ok || window.__nineRouterAppealAccount !== account) return response;
      let request;
      try { request = JSON.parse(await body); } catch { return response; }
      const requestType = request.type;
      if (!/^(threads\.|items\.list$)/.test(requestType || "")) return response;
      let threadId = request.params?.thread_id;
      const record = payload => { threadId = payload.thread?.id || threadId; if (window.__nineRouterAppealAccount === account) report({ requestType, threadId, payload }); };
      const copy = response.clone();
      const capture = async () => {
        const reader = copy.body?.getReader();
        if (!reader) return;
        const decoder = new TextDecoder();
        const streaming = copy.headers.get("content-type")?.includes("text/event-stream");
        let buffer = "", data = [], dataLength = 0;
        const emit = () => {
          if (!data.length) return;
          try { record(JSON.parse(data.join("\n"))); } catch { /* Ignore keepalives. */ }
          data = []; dataLength = 0;
        };
        try {
          for (;;) {
            const { value, done } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            if (buffer.length > 2_000_000) { report({ error: "客服单条数据过大，部分对话未保存。" }); reader.cancel().catch(() => {}); break; }
            if (streaming) {
              let end;
              while ((end = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, end).replace(/\r$/, ""); buffer = buffer.slice(end + 1);
                if (!line) emit();
                else if (line.startsWith("data:")) { data.push(line.slice(5).trimStart()); dataLength += line.length; }
                if (dataLength > 2_000_000) { reader.cancel().catch(() => {}); throw new Error("Capture limit reached"); }
              }
            }
            if (done) {
              if (streaming) { if (buffer.startsWith("data:")) data.push(buffer.slice(5).trimStart()); emit(); }
              else if (buffer) record(JSON.parse(buffer));
              break;
            }
          }
        } finally { reader.releaseLock(); }
      };
      capture().catch(() => report({ error: "客服对话读取中断，已保存的消息仍可查看。" }));
    } catch { /* Recording must not change the support request. */ }
    return response;
  };
}

const validId = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

// Only displayable messages are retained; credentials, tools, URLs and raw payloads are discarded.
export function normalizeAppealMessage(item, fallbackThreadId, complete = true) {
  const threadId = item?.thread_id || fallbackThreadId;
  if (!validId(threadId) || !validId(item?.id) || !["user_message", "assistant_message"].includes(item.type)) return null;
  const text = (Array.isArray(item.content) ? item.content : [])
    .filter(part => ["input_text", "output_text", "input_tag"].includes(part?.type) && typeof part.text === "string")
    .map(part => part.text).join("\n");
  const attachments = (Array.isArray(item.attachments) ? item.attachments : [])
    .map(file => typeof file?.name === "string" ? `[附件：${file.name.slice(0, 200)}]` : "[附件]");
  const content = [text, ...attachments].filter(Boolean).join("\n");
  return { id: item.id, threadId, role: item.type === "user_message" ? "user" : "support", createdAt: timestamp(item.created_at), text: content.slice(0, 100_000), truncated: content.length > 100_000 || !!item.captureTruncated, complete: complete || item.type === "user_message" };
}

export function createAppealCollector(onMessage, onError = () => {}) {
  const pending = new Map();
  const accept = (item, threadId, complete = true) => {
    const message = normalizeAppealMessage(item, threadId, complete);
    if (message?.text) onMessage(message);
    return message;
  };
  return packet => {
    if (packet?.error) { onError("客服对话读取中断，已保存的消息仍可查看。"); return; }
    const value = packet?.payload;
    if (!value || typeof value !== "object") return;
    const threadId = value.thread?.id || value.thread_id || packet.threadId;
    if (["thread.item.added", "thread.item.done", "thread.item.replaced"].includes(value.type)) {
      const message = accept(value.item, threadId, value.type !== "thread.item.added");
      if (message && !message.complete && message.role === "support") {
        if (pending.size >= 32) pending.delete(pending.keys().next().value);
        pending.set(`${message.threadId}:${message.id}`, { ...value.item, thread_id: message.threadId, content: structuredClone(value.item.content || []) });
      } else if (message) pending.delete(`${message.threadId}:${message.id}`);
    } else if (value.type === "thread.item.updated") {
      const item = pending.get(`${threadId}:${value.item_id}`), update = value.update;
      if (!item || !Number.isInteger(update?.content_index) || update.content_index < 0 || update.content_index > 100) return;
      if (["assistant_message.content_part.added", "assistant_message.content_part.done"].includes(update.type)) item.content[update.content_index] = update.content;
      else if (update.type === "assistant_message.content_part.text_delta" && typeof update.delta === "string") {
        const part = item.content[update.content_index];
        if (part?.type === "output_text") { const text = part.text + update.delta; part.text = text.slice(0, 100_000); item.captureTruncated ||= text.length > 100_000; }
      }
      accept(item, threadId, false);
    } else if (packet.requestType === "threads.get_by_id") {
      const thread = value.thread || value;
      for (const item of thread.items?.data || []) accept(item, thread.id || threadId);
    } else if (packet.requestType === "items.list") {
      for (const item of value.data || []) accept(item, threadId);
    }
  };
}
