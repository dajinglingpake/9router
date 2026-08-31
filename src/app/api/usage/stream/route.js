import { statsEmitter, getActiveRequests } from "@/lib/usageDb";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const encoder = new TextEncoder();
  const state = {
    closed: false,
    keepalive: null,
    send: null,
    sendPending: null,
    pushing: false,
    needsPush: false,
  };

  // Next.js does not reliably invoke ReadableStream.cancel() on disconnect.
  // The request signal is the reliable cleanup path for process-wide listeners.
  const cleanup = () => {
    if (state.closed) return;
    state.closed = true;
    if (state.send) statsEmitter.off("update", state.send);
    if (state.sendPending) statsEmitter.off("pending", state.sendPending);
    if (state.keepalive) clearInterval(state.keepalive);
  };
  request?.signal?.addEventListener("abort", cleanup, { once: true });

  const stream = new ReadableStream({
    async start(controller) {
      // Coalesce update bursts and only read the small live request ring.
      const push = async () => {
        if (state.closed) return;
        if (state.pushing) {
          state.needsPush = true;
          return;
        }
        state.pushing = true;
        try {
          const live = await getActiveRequests();
          if (!state.closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(live)}\n\n`));
        } catch {
          cleanup();
        } finally {
          state.pushing = false;
          if (state.needsPush && !state.closed) {
            state.needsPush = false;
            queueMicrotask(push);
          }
        }
      };

      state.send = push;
      state.sendPending = push;

      await push();
      if (state.closed) return;

      statsEmitter.on("update", state.send);
      statsEmitter.on("pending", state.sendPending);

      state.keepalive = setInterval(() => {
        if (state.closed) { clearInterval(state.keepalive); return; }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, 25000);
    },

    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
