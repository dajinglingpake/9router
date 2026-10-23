import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { safeDiagnosticMessage } from "open-sse/utils/upstreamDiagnostics.js";
import { trackTrialResponse } from "./codexTrialSession.js";

function cooldownDelay(response) {
  if (response.status !== 503) return null;
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return null;
  const ms = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(1000, ms) : null;
}

// Keep transient overloads inside the trial request so they cannot exhaust the CLI's reconnect budget.
export async function handleTrialRequest(session, request, handleRequest) {
  const body = await request.arrayBuffer();
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  let attempt = 0;
  const invoke = async () => {
    signal.throwIfAborted();
    const headers = new Headers(request.headers);
    // Each attempt keeps its own diagnostic record, including the original upstream failure.
    if (attempt++) headers.set("x-request-id", randomUUID());
    const response = await handleRequest(new Request(request.url, {
      method: request.method, headers, body, signal,
    }));
    return trackTrialResponse(session, response);
  };
  let response = await invoke();
  if (cooldownDelay(response) === null) return response;

  let output;
  const stream = new TransformStream({ start(controller) { output = controller; } });
  const writer = stream.writable.getWriter();
  const encode = text => new TextEncoder().encode(text);
  let heartbeatPending = false;
  let cooldown = null;
  let heartbeat;
  const abort = () => output.error(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  writer.closed.catch(() => controller.abort());

  async function pump() {
    let reader;
    try {
      // The CLI ignores comment-only heartbeats for its idle timeout. A ping event resets it
      // without creating model output or replaying tool calls.
      heartbeat = setInterval(() => {
        if (heartbeatPending) return;
        heartbeatPending = true;
        writer.write(encode('event: ping\ndata: {"type":"ping"}\n\n'))
          .catch(() => controller.abort()).finally(() => { heartbeatPending = false; });
      }, 10_000);
      let waitMs;
      while ((waitMs = cooldownDelay(response)) !== null) {
        session.cooldownRetries = (session.cooldownRetries || 0) + 1;
        cooldown = { until: Date.now() + waitMs };
        session.cooldown = cooldown;
        const error = await response.text().catch(error => error.message);
        session.logError?.(`[网关自动重试 ${session.cooldownRetries}] HTTP ${response.status} · ${safeDiagnosticMessage(error)} · ${Math.ceil(waitMs / 1000)} 秒后重试`);
        await delay(waitMs, undefined, { signal });
        if (session.cooldown === cooldown) session.cooldown = null;
        response = await invoke();
      }
      clearInterval(heartbeat);
      signal.throwIfAborted();
      if (!response.ok) {
        // Headers have already been sent as SSE; preserve permanent errors in the Responses error frame.
        const raw = await response.text();
        let error;
        try { error = JSON.parse(raw).error; } catch { /* Preserve a non-JSON error below. */ }
        const message = (typeof error === "string" ? error : error?.message) || raw || `HTTP ${response.status}`;
        await writer.write(encode(`event: response.failed\ndata: ${JSON.stringify({
          type: "response.failed", response: { status: "failed", error: {
            code: error?.code || "trial_request_failed", message: `[${response.status}] ${message}`,
          } },
        })}\n\n`));
      } else if (response.body) {
        reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
      }
      await writer.close();
    } catch (error) {
      output.error(error);
    } finally {
      clearInterval(heartbeat);
      signal.removeEventListener("abort", abort);
      if (session.cooldown === cooldown) session.cooldown = null;
      controller.abort();
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      else await response.body?.cancel().catch(() => {});
    }
  }
  void pump();
  return new Response(stream.readable, { headers: {
    "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no",
  } });
}
