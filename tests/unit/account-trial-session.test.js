import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({ getProviderConnectionById: vi.fn(), getSettings: vi.fn().mockResolvedValue({}) }));
vi.mock("@/sse/local/quotaRouting.js", () => ({ loadCodexQuotaSnapshot: vi.fn(), getAccountQuotaState: vi.fn() }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => ({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.test", strictProxy: true }) }));
vi.mock("@/sse/services/concurrencyLimiter.js", () => ({ waitForAccountRequest: vi.fn() }));
import { getProviderConnectionById } from "@/lib/localDb";
import { getAccountQuotaState, loadCodexQuotaSnapshot } from "@/sse/local/quotaRouting.js";
import { createTrialSession, getTrialSession, getTrialCredentials } from "@/sse/local/codexTrialSession";

afterEach(() => vi.clearAllMocks());
describe("account trial pinning", () => {
  it("keeps an active trial authorized beyond twenty minutes and rejects it immediately after revocation", () => {
    vi.useFakeTimers();
    const job = createTrialSession("account", "space-bunny", "xhigh", "codebuddy-cn");
    const request = new Request("http://localhost/v1/responses", { headers: { Authorization: `Bearer ${job.token}` } });
    try {
      vi.advanceTimersByTime(60 * 60_000);
      const other = createTrialSession("another-account", "vendor/model");
      other.revoke();
      expect(getTrialSession(request)).toBe(job.session);
      job.revoke();
      expect(getTrialSession(request)).toBeNull();
    } finally {
      job.revoke();
      vi.useRealTimers();
    }
  });
  it("pins a disabled non-Codex account and preserves its existing proxy configuration", async () => {
    const job = createTrialSession("account", "vendor/model", null, "openai-compatible-fixture");
    getProviderConnectionById.mockResolvedValue({
      id: "account", provider: "openai-compatible-fixture", isActive: false, apiKey: "fixture",
      providerSpecificData: { baseUrl: "https://fixture.test/v1", apiType: "chat" },
    });
    const request = new Request("http://localhost/v1/responses", { headers: { Authorization: `Bearer ${job.token}` } });
    expect(getTrialSession(request)).toMatchObject({ provider: "openai-compatible-fixture", model: "vendor/model" });
    expect(await getTrialCredentials(job.session)).toMatchObject({
      connectionId: "account", isActive: false, routingModel: "vendor/model",
      providerSpecificData: { baseUrl: "https://fixture.test/v1", strictProxy: true, connectionProxyUrl: "http://proxy.test" },
    });
    getProviderConnectionById.mockResolvedValue({ id: "account", provider: "codex" });
    expect(await getTrialCredentials(job.session)).toBeNull();
    job.revoke();
    expect(getTrialSession(request)).toBeNull();
  });
  it("keeps the Codex provider default for legacy callers", () => {
    const job = createTrialSession("account", "gpt-6.1-sol", "xhigh");
    expect(job.session.provider).toBe("codex");
    job.revoke();
  });
  it("applies the credits policy to pinned Codex trials", async () => {
    const job = createTrialSession("account", "gpt-6.1-sol");
    getProviderConnectionById.mockResolvedValue({ id: "account", provider: "codex", isActive: false });
    loadCodexQuotaSnapshot.mockResolvedValue({ credits: { hasCredits: true, balance: 5 } });
    getAccountQuotaState.mockReturnValue({ exhausted: true, retryAt: null });
    try {
      expect(await getTrialCredentials(job.session)).toMatchObject({ sessionUnavailable: true, lastErrorCode: 429 });
      expect(getAccountQuotaState).toHaveBeenCalledWith(expect.anything(), "gpt-6.1-sol", expect.anything(), expect.objectContaining({ allowCredits: false }));
      getAccountQuotaState.mockReturnValue({ exhausted: false });
      expect(await getTrialCredentials(job.session)).toMatchObject({ connectionId: "account" });
    } finally { job.revoke(); }
  });
});
