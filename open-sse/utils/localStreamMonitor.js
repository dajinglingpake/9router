import { FORMATS } from "../translator/formats.js";
import { getOpenAIResponsesEventName } from "./responsesStreamHelpers.js";
import { recordTraffic, recordOutputChunk, beginOutputStream, endOutputStream } from "@/lib/runtimeTraffic.js";

// Local dashboard metrics and completion status stay outside the translator.
export function createLocalStreamMonitor({ targetFormat, connectionId, provider, model }) {
  let failed = false;
  let responsesStream = targetFormat === FORMATS.OPENAI_RESPONSES;
  let completed = false;
  const outputStreamId = beginOutputStream({ connectionId, provider, model });

  return {
    observeOutcome(parsed, eventName = null) {
      const type = getOpenAIResponsesEventName(eventName, parsed);
      if (type?.startsWith("response.")) responsesStream = true;
      if (parsed?.error || parsed?.response?.error || type === "error"
        || type === "response.failed" || type === "response.incomplete"
        || ["failed", "incomplete"].includes(parsed?.response?.status)) failed = true;
      if (type === "response.completed" || type === "response.done" || parsed?.response?.status === "completed") completed = true;
    },
    enqueue(controller, value) {
      recordTraffic({ direction: "download", bytes: value?.byteLength || value?.length || 0 });
      if (value) recordOutputChunk(value, outputStreamId);
      controller.enqueue(value);
    },
    markFailed() { failed = true; },
    finish() { endOutputStream(outputStreamId); },
    isSuccessful() { return !failed && (!responsesStream || completed); },
  };
}
