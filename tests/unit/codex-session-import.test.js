import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/models", () => ({ createProviderConnection: vi.fn() }));
import { createProviderConnection } from "@/models";
import { POST } from "@/app/api/oauth/codex/bulk-import/route";

const jwt = claims => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
const post = async body => (await POST(new Request("http://localhost/api/oauth/codex/bulk-import", {
  method: "POST", body: JSON.stringify(body),
}))).json();

beforeEach(() => {
  vi.clearAllMocks();
  createProviderConnection.mockResolvedValue({ id: "saved" });
});

describe("ChatGPT session import", () => {
  it("records all original website session fields separately from router credentials", async () => {
    const accessToken = jwt({ exp: 2000000000 });
    const result = await post({ user: { id: "user-1", email: "user@example.com", image: "photo" },
      account: { id: "account-1", planType: "plus" }, accessToken,
      expires: "2040-01-01T00:00:00Z", sessionToken: "private-session", authProvider: "openai", provider: "other" });
    expect(result.success).toBe(1);
    const saved = createProviderConnection.mock.calls[0][0];
    expect(saved).toMatchObject({ provider: "codex", email: "user@example.com", accessToken,
      expiresAt: new Date(2000000000000).toISOString(),
      providerSpecificData: { chatgptAccountId: "account-1", chatgptPlanType: "plus" } });
    expect(saved).not.toHaveProperty("user");
    expect(saved).not.toHaveProperty("sessionToken");
    expect(JSON.parse(saved.chatgptSession.raw)).toMatchObject({
      user: { id: "user-1", email: "user@example.com", image: "photo" }, sessionToken: "private-session", authProvider: "openai",
    });
    expect(JSON.stringify(result)).not.toContain(accessToken);
  });

  it("imports arrays of token strings and backfills profile email", async () => {
    const accessToken = jwt({ "https://api.openai.com/profile": { email: "profile@example.com" } });
    const result = await post({ accounts: [accessToken] });
    expect(result.success).toBe(1);
    expect(createProviderConnection.mock.calls[0][0]).toMatchObject({ accessToken, email: "profile@example.com" });
    expect(createProviderConnection.mock.calls[0][0]).not.toHaveProperty("chatgptSession");
  });

  it("backfills JWT account information and supports mixed imports", async () => {
    const accessToken = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "jwt-account", chatgpt_plan_type: "pro" } });
    const result = await post({ accounts: [
      { user: { email: "web@example.com" }, accessToken, expires: "2030-01-01T00:00:00Z" },
      { email: "oauth@example.com", accessToken, refreshToken: "refresh", idToken: "id" },
      { user: { email: "invalid@example.com" } },
    ] });
    expect(result).toMatchObject({ success: 2, failed: 1 });
    expect(createProviderConnection.mock.calls[0][0]).toMatchObject({
      expiresAt: "2030-01-01T00:00:00.000Z",
      providerSpecificData: { chatgptAccountId: "jwt-account", chatgptPlanType: "pro" },
    });
    expect(createProviderConnection.mock.calls[1][0]).toMatchObject({ refreshToken: "refresh", idToken: "id" });
  });

  it("ignores an invalid session expiry", async () => {
    await post({ user: { email: "user@example.com" }, accessToken: "opaque", expires: "invalid" });
    expect(createProviderConnection.mock.calls[0][0]).not.toHaveProperty("expiresAt");
  });
});
