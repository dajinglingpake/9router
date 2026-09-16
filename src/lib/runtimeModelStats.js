import { getRequestLogContext, getRequestTokenUsage } from "./requestCaller.js";
import { safeDiagnosticMessage } from "open-sse/utils/upstreamDiagnostics.js";
import { saveRequestError, markRequestErrorsRecovered } from "./db/repos/requestErrorsRepo.js";

// Runtime totals per account and routed model; request objects keep retries deduplicated.
const state = globalThis._runtimeModelStats ||= { groups: new Map(), requests: new WeakMap() };
state.errors ||= [];

function pruneErrors() {
  const cutoff = Date.now() - 5 * 60 * 1000;
  while (state.errors.length && state.errors[0].timestamp < cutoff) state.errors.shift();
}

export function trackModelRequest(request, { connectionId, provider, model, requestId = null, endpoint = null, caller = {} }) {
  const key = JSON.stringify([connectionId, provider, model]);
  let requests = request && state.requests.get(request);
  if (!requests) {
    requests = new Map();
    if (request) state.requests.set(request, requests);
  }
  if (requests.has(key)) return requests.get(key);

  if (!state.groups.has(key)) {
    state.groups.set(key, { connectionId, provider, model, requests: 0, overloaded: 0, recovered: 0 });
  }
  const group = state.groups.get(key);
  group.requests++;
  let overloaded = false;
  let completed = false;
  const errors = [];
  const errorWrites = [];
  const tracker = {
    onOverload(details = null) {
      if (completed) return;
      if (!overloaded) {
        overloaded = true;
        group.overloaded++;
      }
      if (details) {
        const entry = {
          ...getRequestLogContext({ ...caller, ...details.requestContext }),
          timestamp: Date.now(), connectionId, provider, model, requestId, endpoint,
          status: "FAILED 503", source: "upstream", transient: true, recovered: false,
          message: safeDiagnosticMessage(details.message || "上游服务繁忙或暂不可用"),
          upstreamStatus: details.upstreamStatus,
          retryCount: details.retryCount || 0,
          sseAttempt: details.sseAttempt || 1,
          attempt: details.attempt || 1,
          headers: details.headers || {},
        };
        errors.push(entry);
        state.errors.push(entry);
        errorWrites.push(saveRequestError(entry).catch(() => {
          console.error("[RequestErrors] Failed to persist upstream error");
          return null;
        }));
        pruneErrors();
      }
    },
    onComplete(usage) {
      if (completed) return;
      completed = true;
      if (overloaded) group.recovered++;
      const recoveredUsage = getRequestTokenUsage(usage);
      for (const entry of errors) Object.assign(entry, { recovered: true, recoveredUsage });
      markRequestErrorsRecovered(errorWrites, usage).catch(() => console.error("[RequestErrors] Failed to persist recovery"));
    },
  };
  requests.set(key, tracker);
  return tracker;
}

export function getModelRequestStats() {
  return [...state.groups.values()].map(group => ({ ...group }));
}

export function getModelRequestErrors() {
  pruneErrors();
  return state.errors.map(entry => ({ ...entry }));
}
