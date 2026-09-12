const DEFAULT_QUEUE_TIMEOUT_MS = 10 * 60 * 1000;

const pools = globalThis.__ninerouterConcurrencyPools || new Map();
globalThis.__ninerouterConcurrencyPools = pools;

// Queue entries are exposed to the dashboard, so keep only the small,
// display-safe request summary rather than headers, bodies, or raw API keys.
const QUEUE_METADATA_KEYS = [
  "providerScope",
  "apiKeyName",
  "apiKeyMasked",
  "clientIp",
  "endpoint",
  "requestedModel",
  "upstreamModel",
  "thinkingLevel",
  "sourceFormat",
  "targetFormat",
  "requestBytes",
  "stream",
];

function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return null;
  const safe = {};
  for (const key of QUEUE_METADATA_KEYS) {
    const value = metadata[key];
    if (typeof value === "string" && value.length <= 512) safe[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
    else if (typeof value === "boolean") safe[key] = value;
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

function displayMetadata(metadata) {
  const safe = metadata ? { ...metadata } : {};
  delete safe.providerScope;
  return safe;
}

function normalizeLimit(value) {
  const limit = Number.parseInt(value, 10);
  return Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 0;
}

function queueTimeoutMs() {
  const value = Number.parseInt(process.env.CONCURRENCY_QUEUE_TIMEOUT_MS, 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_QUEUE_TIMEOUT_MS;
}

export class ConcurrencyQueueError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = "ConcurrencyQueueError";
    this.code = code;
    this.status = status;
  }
}

function getPool(key, limit, hidden = false, metadata = null) {
  const safeMetadata = sanitizeMetadata(metadata);
  let pool = pools.get(key);
  if (!pool) {
    pool = { active: 0, limit, queue: [], hidden, metadata: safeMetadata };
    pools.set(key, pool);
  } else {
    pool.limit = limit;
    pool.hidden = pool.hidden || hidden;
    pool.metadata = safeMetadata || pool.metadata;
  }
  return pool;
}

function removeWaiter(pool, waiter) {
  const index = pool.queue.indexOf(waiter);
  if (index >= 0) pool.queue.splice(index, 1);
}

function makePermit(key, pool, queuedAt) {
  let released = false;
  return {
    queued: queuedAt > 0,
    waitMs: queuedAt > 0 ? Date.now() - queuedAt : 0,
    release() {
      if (released) return;
      released = true;
      pool.active = Math.max(0, pool.active - 1);
      dispatch(key, pool);
    },
  };
}

function dispatch(key, pool) {
  // A limit of 0 means unlimited. If a limit is changed to 0 while requests
  // are waiting, release those waiters immediately instead of leaving stale
  // entries until the old queue timeout expires.
  if (pool.limit === 0) {
    while (pool.queue.length > 0) {
      const waiter = pool.queue.shift();
      if (waiter.signal?.aborted) {
        waiter.reject(new ConcurrencyQueueError("Request aborted while waiting for concurrency slot", "queue_aborted", 499));
        continue;
      }
      clearTimeout(waiter.timer);
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.resolve({
        queued: true,
        waitMs: Math.max(0, Date.now() - waiter.queuedAt),
        release() {},
      });
    }
  }

  while (pool.active < pool.limit && pool.queue.length > 0) {
    const waiter = pool.queue.shift();
    if (waiter.signal?.aborted) {
      waiter.reject(new ConcurrencyQueueError("Request aborted while waiting for concurrency slot", "queue_aborted", 499));
      continue;
    }

    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    pool.active++;
    waiter.resolve(makePermit(key, pool, waiter.queuedAt));
  }

  if (pool.active === 0 && pool.queue.length === 0) pools.delete(key);
}

/**
 * Acquire a FIFO concurrency slot. A non-positive limit means unlimited.
 */
export function acquireConcurrencySlot({ scope, id, limit, signal, onQueued, requestId, hideFromSnapshot = false, metadata = null }) {
  const normalizedLimit = normalizeLimit(limit);
  if (!id) {
    return Promise.resolve({ queued: false, waitMs: 0, release() {} });
  }

  const key = `${scope}:${id}`;
  const existingPool = pools.get(key);
  if (normalizedLimit === 0) {
    if (existingPool) {
      existingPool.limit = 0;
      existingPool.hidden = existingPool.hidden || hideFromSnapshot;
      dispatch(key, existingPool);
    }
    return Promise.resolve({ queued: false, waitMs: 0, release() {} });
  }

  if (signal?.aborted) {
    return Promise.reject(new ConcurrencyQueueError("Request aborted before entering concurrency queue", "queue_aborted", 499));
  }

  const safeMetadata = sanitizeMetadata(metadata);
  const pool = getPool(key, normalizedLimit, hideFromSnapshot, metadata);
  if (pool.active < pool.limit && pool.queue.length === 0) {
    pool.active++;
    return Promise.resolve(makePermit(key, pool, 0));
  }

  return new Promise((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      signal,
      queuedAt: Date.now(),
      timer: null,
      onAbort: null,
      requestId: requestId || null,
      metadata: safeMetadata,
    };

    waiter.onAbort = () => {
      removeWaiter(pool, waiter);
      clearTimeout(waiter.timer);
      reject(new ConcurrencyQueueError("Request aborted while waiting for concurrency slot", "queue_aborted", 499));
      dispatch(key, pool);
    };
    waiter.timer = setTimeout(() => {
      removeWaiter(pool, waiter);
      signal?.removeEventListener("abort", waiter.onAbort);
      reject(new ConcurrencyQueueError("Concurrency queue wait timed out", "queue_timeout", 503));
      dispatch(key, pool);
    }, queueTimeoutMs());

    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    pool.queue.push(waiter);
    onQueued?.({ position: pool.queue.length, active: pool.active, limit: pool.limit });
  });
}

/**
 * Streaming responses retain their slot until EOF/cancel. JSON responses can
 * release immediately because the upstream work is already complete.
 */
export function holdConcurrencyUntilResponseDone(response, release) {
  const contentType = response?.headers?.get?.("content-type") || "";
  if (!response?.body || !contentType.toLowerCase().includes("text/event-stream")) {
    release();
    return response;
  }

  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export const __test__ = {
  reset() {
    for (const pool of pools.values()) {
      for (const waiter of pool.queue) {
        clearTimeout(waiter.timer);
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
      }
    }
    pools.clear();
  },
  snapshot(scope, id) {
    const pool = pools.get(`${scope}:${id}`);
    return pool ? { active: pool.active, queued: pool.queue.length, limit: pool.limit } : null;
  },
};

export function getConcurrencySnapshot() {
  return [...pools.entries()].map(([key, pool]) => {
    // Unlimited pools do not represent a visible concurrency constraint. This
    // also hides the short-lived pool left by requests that started before a
    // limit was changed to 0.
    if (pool.hidden || pool.limit === 0) return null;
    const separator = key.indexOf(":");
    return {
      scope: separator >= 0 ? key.slice(0, separator) : "unknown",
      id: separator >= 0 ? key.slice(separator + 1) : key,
      active: pool.active,
      queued: pool.queue.length,
      limit: pool.limit,
      queue: pool.queue.map((waiter, index) => ({
        requestId: waiter.requestId,
        position: index + 1,
        queuedAt: waiter.queuedAt,
        waitMs: Math.max(0, Date.now() - waiter.queuedAt),
        ...displayMetadata(waiter.metadata),
      })),
    };
  }).filter(Boolean);
}
