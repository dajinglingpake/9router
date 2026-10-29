import { expect, it, vi } from "vitest";

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({ getProviderConnectionById: vi.fn(), updateProviderConnection: vi.fn() }));
vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider: vi.fn() }));
vi.mock("open-sse/executors/index.js", () => ({ getExecutor: vi.fn() }));
vi.mock("@/lib/network/initOutboundProxy", () => ({ ensureOutboundProxyInitialized: vi.fn() }));
import { getUsageForProvider } from "open-sse/services/usage.js";
import { ensureOutboundProxyInitialized } from "@/lib/network/initOutboundProxy";
import { loadConnectionUsage, supportsConnectionUsage } from "@/lib/providerUsage";

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
