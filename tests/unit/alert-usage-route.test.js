import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connection: vi.fn(), usage: vi.fn(), notify: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getProviderConnectionById: mocks.connection }));
vi.mock("@/lib/providerUsage", () => ({ loadConnectionUsage: mocks.usage, refreshAndUpdateCredentials: vi.fn() }));
vi.mock("@/lib/alerts/monitor", () => ({ notifyAccountUsage: mocks.notify }));
import { GET } from "../../src/app/api/usage/[connectionId]/route.js";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.connection.mockResolvedValue({ id: "a", provider: "codex" });
  mocks.usage.mockResolvedValue({ quotas: { session: { used: 95, total: 100 } } });
  mocks.notify.mockResolvedValue();
});

it("reuses the quota response for alerts without querying the provider again", async () => {
  const response = await GET(new Request("http://localhost/api/usage/a?force=1"), { params: Promise.resolve({ connectionId: "a" }) });
  const data = await response.json();
  expect(mocks.usage).toHaveBeenCalledTimes(1);
  expect(mocks.usage).toHaveBeenCalledWith({ id: "a", provider: "codex" }, { force: true });
  expect(mocks.notify).toHaveBeenCalledWith({ id: "a", provider: "codex" }, data);
});

it("still returns quota when evaluating the notification fails", async () => {
  mocks.notify.mockRejectedValue(new Error("notification unavailable"));
  const response = await GET(new Request("http://localhost/api/usage/a"), { params: Promise.resolve({ connectionId: "a" }) });
  expect(response.status).toBe(200);
  expect((await response.json()).quotas.session.used).toBe(95);
  expect(mocks.usage).toHaveBeenCalledTimes(1);
});
