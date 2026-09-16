import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: vi.fn() }));
vi.mock("../../src/lib/db/repos/requestErrorsRepo.js", () => ({ saveRequestError: vi.fn(async () => 1) }));

import { appendRequestLog, getRuntimeRequestErrors } from "../../src/lib/db/repos/usageRepo.js";

describe("runtime request error details", () => {
  beforeEach(() => {
    global._runtimeRequestErrors.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("retains upstream error context without retaining unrelated credentials", async () => {
    await appendRequestLog({ status: "FAILED 503", model: "test-model", provider: "test", connectionId: "account-1", requestId: "local-1", retryCount: 2, message: "overloaded Bearer private-token sk-secret", apiKey: "private-key", apiKeyId: "caller-1", apiKeyName: "开发客户端", apiKeyMasked: "test...1234", clientIp: "192.0.2.10", userAgent: "test-cli/1.0", requestedModel: "client-alias" });
    expect(getRuntimeRequestErrors()).toMatchObject([{
      timestamp: Date.now(), status: "FAILED 503", model: "test-model", provider: "test", connectionId: "account-1",
      source: "upstream", endpoint: null,
      requestId: "local-1", retryCount: 2,
      apiKeyId: "caller-1", apiKeyName: "开发客户端", apiKeyMasked: "test...1234", clientIp: "192.0.2.10", userAgent: "test-cli/1.0", requestedModel: "client-alias",
      message: "overloaded Bearer [REDACTED] [REDACTED]",
    }]);
  });

  it("ignores successful requests and expires errors after five minutes", async () => {
    await appendRequestLog({ status: "200 OK" });
    await appendRequestLog({ status: "PENDING" });
    expect(getRuntimeRequestErrors()).toEqual([]);
    await appendRequestLog({ status: "FAILED 502" });
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(getRuntimeRequestErrors()).toEqual([]);
  });
});
