import { afterEach, expect, it, vi } from "vitest";
import { waitForAccountRequest, __test__ as concurrencyTest } from "../../src/sse/services/concurrencyLimiter.js";

afterEach(() => {
  concurrencyTest.reset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("spaces upstream attempts by a randomized interval within the configured range", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);

  await waitForAccountRequest({ id: "account-a", minIntervalMs: 1000, maxIntervalMs: 3000 });
  let secondStarted = false;
  const second = waitForAccountRequest({ id: "account-a", minIntervalMs: 1000, maxIntervalMs: 3000 }).then(() => {
    secondStarted = true;
  });

  await vi.advanceTimersByTimeAsync(999);
  expect(secondStarted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await second;
  expect(secondStarted).toBe(true);
});

it("can use the upper end of the randomized interval", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.999999);

  await waitForAccountRequest({ id: "account-c", minIntervalMs: 1000, maxIntervalMs: 3000 });
  let secondStarted = false;
  const second = waitForAccountRequest({ id: "account-c", minIntervalMs: 1000, maxIntervalMs: 3000 }).then(() => {
    secondStarted = true;
  });

  await vi.advanceTimersByTimeAsync(2999);
  expect(secondStarted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await second;
  expect(secondStarted).toBe(true);
});

it("does not delay accounts with the interval disabled", async () => {
  const startedAt = Date.now();
  await waitForAccountRequest({ id: "account-b", minIntervalMs: 0 });
  await waitForAccountRequest({ id: "account-b", minIntervalMs: 0 });
  expect(Date.now() - startedAt).toBe(0);
});
