import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ usage: vi.fn(), update: vi.fn(), proxy: vi.fn(), needsRefresh: vi.fn(), refresh: vi.fn() }));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({ updateProviderConnection: mocks.update }));
vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider: mocks.usage }));
vi.mock("open-sse/executors/index.js", () => ({ getExecutor: () => ({ needsRefresh: mocks.needsRefresh, refreshCredentials: mocks.refresh }) }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: mocks.proxy }));
import { loadConnectionUsage } from "../../src/lib/providerUsage.js";

const connection = { id: "a", provider: "codex", authType: "oauth", accessToken: "old", refreshToken: "refresh", providerSpecificData: {} };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.proxy.mockResolvedValue({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.test:7890" });
  mocks.needsRefresh.mockReturnValue(false);
  mocks.usage.mockResolvedValue({ quotas: {} });
});

it("uses the account proxy and forwards the background check timeout", async () => {
  const signal = new AbortController().signal;
  await loadConnectionUsage(connection, { signal });
  expect(mocks.usage).toHaveBeenCalledWith(connection, expect.objectContaining({ strictProxy: true, signal, connectionProxyUrl: "http://proxy.test:7890" }), { force: false });
  expect(mocks.refresh).not.toHaveBeenCalled();
});

it("refreshes expired OAuth credentials once and uses the updated token", async () => {
  mocks.usage.mockResolvedValueOnce({ message: "401 unauthorized" });
  mocks.refresh.mockResolvedValue({ accessToken: "new", expiresIn: 3600 });
  await loadConnectionUsage(connection);
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
  expect(mocks.update).toHaveBeenCalledWith("a", expect.objectContaining({ accessToken: "new" }));
  expect(mocks.usage.mock.calls[1][0].accessToken).toBe("new");
});

it("does not attempt OAuth refresh for DeepSeek API keys", async () => {
  mocks.proxy.mockResolvedValue({ connectionProxyEnabled: false });
  await loadConnectionUsage({ id: "d", provider: "deepseek", authType: "apikey", apiKey: "test-only" });
  expect(mocks.usage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ strictProxy: false }), { force: false });
  expect(mocks.refresh).not.toHaveBeenCalled();
});

it("preserves the authentication failure status for quota API callers", async () => {
  mocks.needsRefresh.mockReturnValue(true);
  mocks.refresh.mockRejectedValue(new Error("expired"));
  await expect(loadConnectionUsage(connection)).rejects.toMatchObject({ status: 401 });
});
