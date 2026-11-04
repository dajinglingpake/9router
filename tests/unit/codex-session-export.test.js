import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/models", () => ({ getProviderConnectionById: vi.fn() }));
vi.mock("@/lib/providerUsage", () => ({ refreshAndUpdateCredentials: vi.fn() }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn() }));

import { getProviderConnectionById } from "@/models";
import { refreshAndUpdateCredentials } from "@/lib/providerUsage";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { GET } from "@/app/api/providers/[id]/session-export/route";
import { toProviderConnectionResponse } from "@/lib/providerConnectionResponse";

const jwt = claims => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
const invoke = () => GET(new Request("http://localhost/api/providers/account/session-export"), {
  params: Promise.resolve({ id: "account" }),
});
let connection;
beforeEach(() => {
  vi.resetAllMocks();
  connection = { id: "account", provider: "codex", authType: "oauth", email: "user@example.com",
    accessToken: jwt({ sub: "user-1", exp: 2000000000,
      "https://api.openai.com/auth": { chatgpt_account_id: "jwt-account", chatgpt_plan_type: "plus" },
    }),
    refreshToken: "private-refresh", idToken: jwt({ name: "User", sub: "user-1" }),
    expiresAt: "2040-01-01T00:00:00Z", providerSpecificData: { proxyPoolId: "private-proxy" },
  };
  connection.chatgptSession = { raw: '{"sessionToken":"web-session-token","accessToken":"web-access-token"}' };
  getProviderConnectionById.mockImplementation(async () => connection);
  refreshAndUpdateCredentials.mockImplementation(async value => ({ connection: value, refreshed: false }));
  resolveConnectionProxyConfig.mockResolvedValue({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.invalid" });
});

describe("Codex Session TXT download", () => {
  it("downloads account fields and token expiry from existing credentials without a browser login", async () => {
    const response = await invoke();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="session-user@example.com.txt"');
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ user: { id: "user-1", name: "User", email: "user@example.com" },
      account: { id: "jwt-account", planType: "plus" }, accessToken: connection.accessToken,
      expires: new Date(2000000000000).toISOString(),
    });
    expect(body).not.toMatch(/private-refresh|private-proxy|idToken|refreshToken/);
    expect(refreshAndUpdateCredentials).toHaveBeenCalledWith(connection, false, expect.objectContaining({
      connectionProxyUrl: "http://proxy.invalid", signal: expect.any(AbortSignal),
    }));
  });

  it("does not expose the saved browser credentials in ordinary provider responses", () => {
    const response = toProviderConnectionResponse(connection);
    expect(response).not.toHaveProperty("chatgptSession");
    expect(JSON.stringify(response)).not.toMatch(/web-session-token|web-access-token|private-refresh/);
  });

  it("downloads directly when no website session has been saved", async () => {
    delete connection.chatgptSession;
    const response = await invoke();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accessToken: connection.accessToken });
  });

  it("returns 404 for deleted accounts", async () => {
    connection = null;
    expect((await invoke()).status).toBe(404);
  });

  it.each([
    { provider: "other", authType: "oauth" },
    { provider: "codex", authType: "apikey" },
    { accessToken: null },
  ])("rejects unsupported or logged-out accounts: %j", async fields => {
    connection = { ...connection, ...fields };
    const response = await invoke();
    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Disposition")).toBeNull();
  });

  it("uses the account's selected workspace", async () => {
    connection.providerSpecificData.workspaceId = "selected-workspace";
    connection.providerSpecificData.chatgptAccountId = "original-workspace";
    const response = await invoke();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ account: { id: "selected-workspace" } });
  });

  it("does not export unrelated saved website credentials", async () => {
    const response = await invoke();
    expect(response.status).toBe(200);
    expect(await response.text()).not.toMatch(/web-session-token|web-access-token/);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("sanitizes the download filename", async () => {
    connection.email = "a\"\r\n/b@example.com";
    const response = await invoke();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="session-a____b@example.com.txt"');
  });

  it("exports refreshed credentials", async () => {
    const accessToken = jwt({ exp: 2100000000 });
    refreshAndUpdateCredentials.mockResolvedValue({ connection: { ...connection, accessToken }, refreshed: true });
    expect(await (await invoke()).json()).toMatchObject({ accessToken, expires: new Date(2100000000000).toISOString() });
  });

  it("rejects expired credentials and hides internal refresh errors", async () => {
    connection.accessToken = jwt({ exp: 1 });
    expect((await invoke()).status).toBe(401);
    refreshAndUpdateCredentials.mockRejectedValue(new Error("private-refresh"));
    const response = await invoke();
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("private-refresh");
  });

  it("supports access-token accounts and profile identity without a refresh token", async () => {
    connection = { id: "account", provider: "codex", authType: "access_token",
      accessToken: jwt({ "https://api.openai.com/profile": { email: "profile@example.com" } }),
      expiresAt: "2030-01-01T00:00:00Z",
    };
    expect(await (await invoke()).json()).toMatchObject({ user: { email: "profile@example.com" }, expires: "2030-01-01T00:00:00.000Z" });
    expect(refreshAndUpdateCredentials).not.toHaveBeenCalled();
  });
});
