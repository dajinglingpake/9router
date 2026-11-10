import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ verify: vi.fn(), settings: vi.fn(), start: vi.fn(), frame: vi.fn(), action: vi.fn() }));
vi.mock("@/lib/auth/dashboardSession", () => ({ verifyDashboardAuthToken: mocks.verify, shouldUseSecureCookie: () => false }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.settings }));
vi.mock("@/lib/oauth/codexBrowserLogin", () => ({ startCodexBrowserLogin: mocks.start, codexBrowserLoginFrame: mocks.frame, codexBrowserLoginAction: mocks.action }));
import { GET, POST } from "@/app/api/oauth/codex/browser-login/route";

function request(body = { type: "start", connectionId: "account", requestId: "request" }, headers = {}, cookies = {}) {
  return { url: "http://localhost:20128/api/oauth/codex/browser-login",
    nextUrl: new URL("http://localhost:20128/api/oauth/codex/browser-login?id=login"),
    headers: new Headers({ Origin: "http://localhost:20128", Host: "localhost:20128", "Content-Type": "application/json", ...headers }),
    cookies: { get: name => cookies[name] ? { value: cookies[name] } : undefined },
    json: async () => body,
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.verify.mockResolvedValue(false); mocks.settings.mockResolvedValue({ requireLogin: false });
  mocks.start.mockResolvedValue({ id: "login" }); mocks.frame.mockResolvedValue({ id: "login", status: "web" }); mocks.action.mockResolvedValue({ closed: true });
});

describe("Codex browser login request ownership", () => {
  it("binds guest browser sessions to an HTTP-only cookie without returning credentials", async () => {
    const response = await POST(request());
    expect(response.status).toBe(202);
    const cookie = response.headers.get("Set-Cookie");
    expect(cookie).toContain("Path=/api/oauth/codex/browser-login; HttpOnly; SameSite=Strict");
    const value = cookie.match(/9router_codex_browser_login=([a-f0-9]{64})/)[1];
    const owner = mocks.start.mock.calls[0][1];
    expect(mocks.start).toHaveBeenCalledWith("account", owner, "request", 20128);
    expect(await response.json()).toEqual({ id: "login" });
    expect((await GET(request(null, {}, { "9router_codex_browser_login": value }))).status).toBe(200);
    expect(mocks.frame).toHaveBeenCalledWith("login", owner, true);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("requires a valid owner cookie to view a guest window", async () => {
    expect((await GET(request())).status).toBe(401);
    expect(mocks.frame).not.toHaveBeenCalled();
  });

  it("requires dashboard login when configured", async () => {
    mocks.settings.mockResolvedValue({ requireLogin: true });
    expect((await POST(request())).status).toBe(401);
    expect(mocks.start).not.toHaveBeenCalled();
    mocks.verify.mockResolvedValue(true);
    expect((await POST(request(undefined, {}, { auth_token: "valid-token" }))).status).toBe(202);
  });

  it.each(["http://other.example", "https://other.example", "null"])("rejects an invalid request origin: %s", async origin => {
    expect((await POST(request(undefined, { Origin: origin }))).status).toBe(403);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON and non-JSON input", async () => {
    const invalid = request(); invalid.json = async () => { throw new Error("invalid"); };
    expect((await POST(invalid)).status).toBe(400);
    expect((await POST(request(undefined, { "Content-Type": "text/plain" }))).status).toBe(415);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("does not expose internal credentials in error responses", async () => {
    mocks.start.mockRejectedValue(new Error("private-code-verifier"));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private-code-verifier");
  });
});
