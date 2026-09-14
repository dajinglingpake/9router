import { describe, expect, it } from "vitest";

import { holdConcurrencyUntilResponseDone } from "../../src/sse/services/concurrencyLimiter.js";
import { createDisconnectAwareStream } from "../../open-sse/utils/streamHandler.js";
import { buildAbortedResponsesTerminalBytes } from "../../open-sse/utils/responsesStreamHelpers.js";

function makeController(abortController) {
  let connected = true;
  return {
    signal: abortController.signal,
    startTime: Date.now(),
    isConnected: () => connected,
    handleComplete: () => { connected = false; },
    handleError: () => { connected = false; },
    handleDisconnect: () => { connected = false; },
    abort: () => abortController.abort(),
  };
}

describe("concurrency slot release", () => {
  it("releases when request.signal aborts even if the stream never closes", async () => {
    const requestController = new AbortController();
    let released = false;
    const neverEnding = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\n\n"));
      },
    });
    const response = new Response(neverEnding, {
      headers: { "Content-Type": "text/event-stream" },
    });

    const wrapped = holdConcurrencyUntilResponseDone(
      response,
      () => { released = true; },
      { signal: requestController.signal }
    );

    const reader = wrapped.body.getReader();
    await reader.read();
    expect(released).toBe(false);

    requestController.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(released).toBe(true);

    await reader.cancel();
  });

  it("closes the downstream stream when the controller signal aborts during a stall", async () => {
    const abortController = new AbortController();
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: response.created\ndata: {}\n\n"));
      },
    });
    const streamController = makeController(abortController);
    const out = createDisconnectAwareStream(
      { readable: upstream, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
      streamController,
      buildAbortedResponsesTerminalBytes
    );

    const reader = out.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    abortController.abort();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    expect(text).toContain("response.failed");
    expect(text).toContain("data: [DONE]");
  });
});
