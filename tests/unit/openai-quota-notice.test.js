import { expect, it, vi } from "vitest";

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({ getProviderConnectionById: vi.fn(), updateProviderConnection: vi.fn() }));
vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider: vi.fn() }));
vi.mock("open-sse/executors/index.js", () => ({ getExecutor: vi.fn() }));
vi.mock("@/lib/network/initOutboundProxy", () => ({ ensureOutboundProxyInitialized: vi.fn() }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn() }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
vi.mock("@/lib/db/repos/usageRepo.js", () => ({ getUsageHistory: vi.fn() }));
vi.mock("@/lib/db/repos/pricingRepo.js", () => ({ getPricing: vi.fn().mockResolvedValue({}) }));
import { getUsageForProvider } from "open-sse/services/usage.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { updateProviderConnection } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { ensureOutboundProxyInitialized } from "@/lib/network/initOutboundProxy";
import { loadConnectionUsage, supportsConnectionUsage } from "@/lib/providerUsage";
import { getUsageHistory } from "@/lib/db/repos/usageRepo.js";

it("explains unavailable OpenAI quotas without querying billing or fabricating a zero balance", async () => {
  const account = { provider: "openai", authType: "apikey", apiKey: "secret" };
  expect(supportsConnectionUsage(account)).toBe(false);
  const result = await loadConnectionUsage(account);
  expect(result.message).toContain("Admin Key");
  expect(result.detailUrl).toBe("https://platform.openai.com/settings/organization/billing/overview");
  expect(result).not.toHaveProperty("quotas");
  expect(result).not.toHaveProperty("balance");
  expect(getUsageForProvider).not.toHaveBeenCalled();
  expect(ensureOutboundProxyInitialized).not.toHaveBeenCalled();
});

it("uses Admin Key through the usage loader, preserving strict proxy policy and account health", async () => {
  const account = { provider: "openai", authType: "apikey", apiKey: "model-key", openaiAdminKey: "admin-key" };
  const controller = new AbortController();
  resolveConnectionProxyConfig.mockResolvedValue({ connectionProxyEnabled: false, strictProxy: true });
  proxyAwareFetch.mockImplementation(async () => Response.json({ data: [], has_more: false }));
  expect(supportsConnectionUsage(account)).toBe(true);
  await loadConnectionUsage(account, { signal: controller.signal });
  await loadConnectionUsage(account, { force: true });
  expect(proxyAwareFetch).toHaveBeenCalledTimes(4);
  expect(proxyAwareFetch).toHaveBeenCalledWith(expect.stringContaining("api.openai.com"),
    expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer admin-key" }) }),
    expect.objectContaining({ connectionProxyEnabled: false, strictProxy: true }));
  controller.abort();
  expect(proxyAwareFetch.mock.calls[0][1].signal.aborted).toBe(true);
  proxyAwareFetch.mockImplementation(async () => new Response("denied", { status: 403 }));
  await expect(loadConnectionUsage(account, { force: true })).rejects.toThrow("无权查询");
  expect(updateProviderConnection).not.toHaveBeenCalled();
  expect(getUsageForProvider).not.toHaveBeenCalled();
});

it("falls back to this account's local usage when organization billing is unavailable", async () => {
  const openaiBalance = { amount: 12, recordedAt: "2026-10-01T03:00:00.000Z" };
  const account = { id: "account-a", provider: "openai", authType: "apikey", apiKey: "model-key", openaiAdminKey: "denied", openaiBalance };
  getUsageHistory.mockResolvedValue([{ model: "gpt-6.2-sol", cost: 1.5 }]);
  proxyAwareFetch.mockImplementation(async () => new Response(null, { status: 403 }));
  const result = await loadConnectionUsage(account, { force: true });
  expect(result.message).toContain("无权查询");
  expect(result.openaiUsage.balance).toMatchObject({ source: "local", remaining: 10.5 });
  expect(getUsageHistory).toHaveBeenCalledWith({ provider: "openai", connectionId: account.id, startDate: openaiBalance.recordedAt });
});
