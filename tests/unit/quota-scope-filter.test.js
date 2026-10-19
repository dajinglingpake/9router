import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connections: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getProviderConnections: mocks.connections }));
vi.mock("@/lib/oauth/providers", () => ({ backfillCodexEmails: vi.fn() }));
vi.mock("@/lib/db/repos/accountOverloadWarningsRepo", () => ({ getAccountOverloadWarnings: async () => ({}) }));
vi.mock("@/lib/accountApiKeyBindings.js", () => ({ getExclusiveApiKeyNames: async () => new Map() }));
vi.mock("@/lib/recentAccountApiKeyUsers.js", () => ({ getRecentAccountApiKeyUsers: async () => new Map() }));

import { GET } from "@/app/api/providers/client/route.js";
const connection = (id, extra = {}) => ({ id, provider: "codex", authType: "oauth", isActive: true, ...extra });
beforeEach(() => {
  mocks.connections.mockResolvedValue([
    connection("shared-1", { priority: 1 }),
    connection("dedicated-1", { priority: 2, exclusiveApiKeyIds: ["a"] }),
    connection("shared-2", { priority: 3, exclusiveApiKeyIds: [] }),
    connection("dedicated-2", { priority: 4, exclusiveApiKeyId: "deleted-key", isActive: false }),
    connection("claude", { provider: "claude", priority: 5, exclusiveApiKeyIds: ["b"] }),
  ]);
});

const read = async query => (await GET(new Request(`http://localhost/api/providers/client?${query}`))).json();

describe("quota ownership filtering", () => {
  it("filters across all pages before paginating shared accounts", async () => {
    const result = await read("quotaScope=shared&pageSize=1&page=2");
    expect(result.connections.map(item => item.id)).toEqual(["shared-2"]);
    expect(result.pagination).toMatchObject({ total: 2, totalPages: 2, page: 2 });
  });

  it("combines provider, active status and dedicated scope", async () => {
    const result = await read("provider=codex&quotaScope=dedicated&accountStatus=active");
    expect(result.connections.map(item => item.id)).toEqual(["dedicated-1"]);
    expect(result.pagination.total).toBe(1);
  });

  it("keeps disabled and deleted legacy bindings dedicated", async () => {
    const result = await read("quotaScope=dedicated&accountStatus=inactive");
    expect(result.connections.map(item => item.id)).toEqual(["dedicated-2"]);
  });

  it("defaults to all scopes and keeps provider choices available for empty filters", async () => {
    expect((await read("")).pagination.total).toBe(5);
    const empty = await read("provider=claude&quotaScope=shared");
    expect(empty.connections).toEqual([]);
    expect(empty.totals.eligibleConnections).toBe(5);
    expect(empty.providerOptions).toEqual(["claude", "codex"]);
  });
});
