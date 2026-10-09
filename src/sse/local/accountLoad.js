import { acquireConcurrencySlot } from "../services/concurrencyLimiter.js";

// Unlimited slots are not counted by the limiter, but still occupy an account.
const activeRequests = globalThis.__ninerouterAccountRoutingLoads ||= new Map();

export function getAccountActiveCount(id) {
  return activeRequests.get(id) || 0;
}

export function acquireAccountSlot(options, onRegistered) {
  const pending = acquireConcurrencySlot(options);
  const limited = Number.parseInt(options.limit, 10) > 0;
  if (limited) onRegistered?.();
  return pending.then(permit => {
    const id = options.id;
    activeRequests.set(id, getAccountActiveCount(id) + 1);
    if (!limited) onRegistered?.();
    let released = false;
    return {
      ...permit,
      release() {
        if (released) return;
        released = true;
        const remaining = getAccountActiveCount(id) - 1;
        if (remaining > 0) activeRequests.set(id, remaining);
        else activeRequests.delete(id);
        permit.release();
      },
    };
  });
}
