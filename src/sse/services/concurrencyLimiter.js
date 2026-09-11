const DEFAULT_QUEUE_TIMEOUT_MS = 10 * 60 * 1000;

const pools = globalThis.__ninerouterConcurrencyPools || new Map();
globalThis.__ninerouterConcurrencyPools = pools;

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

function getPool(key, limit) {
  let pool = pools.get(key);
  if (!pool) {
    pool = { active: 0, limit, queue: [] };
    pools.set(key, pool);
  } else {
    pool.limit = limit;
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
export function acquireConcurrencySlot({ scope, id, limit, signal, onQueued, requestId }) {
  const normalizedLimit = normalizeLimit(limit);
  if (!id || normalizedLimit === 0) {
    return Promise.resolve({ queued: false, waitMs: 0, release() {} });
  }

  if (signal?.aborted) {
    return Promise.reject(new ConcurrencyQueueError("Request aborted before entering concurrency queue", "queue_aborted", 499));
  }

  const key = `${scope}:${id}`;
  const pool = getPool(key, normalizedLimit);
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
      })),
    };
  });
}
