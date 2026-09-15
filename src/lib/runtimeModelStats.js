// Runtime totals per account and routed model; request objects keep retries deduplicated.
const state = globalThis._runtimeModelStats ||= { groups: new Map(), requests: new WeakMap() };

export function trackModelRequest(request, { connectionId, provider, model }) {
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
  const tracker = {
    onOverload() {
      if (overloaded || completed) return;
      overloaded = true;
      group.overloaded++;
    },
    onComplete() {
      if (completed) return;
      completed = true;
      if (overloaded) group.recovered++;
    },
  };
  requests.set(key, tracker);
  return tracker;
}

export function getModelRequestStats() {
  return [...state.groups.values()].map(group => ({ ...group }));
}
