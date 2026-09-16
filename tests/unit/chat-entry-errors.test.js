import { beforeEach, expect, it, vi } from "vitest";
import { zstdCompressSync } from "node:zlib";

const mocks = vi.hoisted(() => ({
  appendRequestLog: vi.fn().mockResolvedValue(),
  getSettings: vi.fn(),
  isValidApiKey: vi.fn(),
  getModelInfo: vi.fn(),
  getApiKeyByValue: vi.fn(),
}));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/usageDb.js", () => ({ appendRequestLog: mocks.appendRequestLog }));
vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getApiKeyByValue: mocks.getApiKeyByValue,
  getProviderConnectionById: vi.fn(),
  getProviderConnections: async () => [],
}));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: async () => null,
  markAccountUnavailable: vi.fn(), clearAccountError: vi.fn(),
  extractApiKey: (request) => request.headers.get("authorization")?.replace("Bearer ", "") || null,
  isValidApiKey: mocks.isValidApiKey,
}));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: async () => null,
  getComboAccountModels: async () => ({}),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: vi.fn() }));
vi.mock("../../src/sse/utils/logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn(), maskKey: () => "masked",
}));

import { handleChat } from "../../src/sse/handlers/chat.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({ requireApiKey: false });
  mocks.getApiKeyByValue.mockResolvedValue(null);
  mocks.isValidApiKey.mockResolvedValue(false);
  mocks.getModelInfo.mockResolvedValue({ provider: "test", model: "test-model" });
});

it("records the authenticated caller on router errors without logging credentials", async () => {
  mocks.getApiKeyByValue.mockResolvedValue({ id: "caller-1", name: "客户端甲", isActive: true });
  await handleChat(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer private-key", "x-forwarded-for": "192.0.2.10", "user-agent": "test-cli/1.0", "x-request-id": "caller-request" },
    body: JSON.stringify({ model: "test-model", apiKeyName: "伪造名称", apiKey: "body-secret" }),
  }));
  expect(mocks.appendRequestLog).toHaveBeenCalledWith(expect.objectContaining({
    status: "FAILED 503", apiKeyId: "caller-1", apiKeyName: "客户端甲", apiKeyMasked: "masked",
    clientIp: "192.0.2.10", userAgent: "test-cli/1.0", requestId: "caller-request", requestedModel: "test-model",
  }));
  expect(JSON.stringify(mocks.appendRequestLog.mock.calls)).not.toMatch(/private-key|body-secret|伪造名称/);
});

it.each(["not json", "null", "[]"])("records invalid input %s before upstream work", async (body) => {
  const response = await handleChat(new Request("http://localhost/v1/chat/completions", { method: "POST", body }));
  expect(response.status).toBe(400);
  expect(mocks.appendRequestLog).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: "client", status: "FAILED 400", message: "Invalid JSON body", endpoint: "/v1/chat/completions" }));
});

it("records a missing model", async () => {
  const response = await handleChat(new Request("http://localhost/v1/chat/completions", { method: "POST", body: "{}" }));
  expect(response.status).toBe(400);
  expect(mocks.appendRequestLog).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: "client", message: "Missing model" }));
});

it("decodes native Codex requests before normal model and account routing", async () => {
  const response = await handleChat(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-encoding": "zstd" },
    body: zstdCompressSync(JSON.stringify({ model: "test-model", input: "hello" })),
  }));
  expect(mocks.getModelInfo).toHaveBeenCalledWith("test-model");
  expect(response.status).toBe(503); // Normal missing-credentials path, not a JSON error.
});

it("reports malformed zstd as invalid JSON before selecting an account", async () => {
  const response = await handleChat(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-encoding": "zstd" }, body: "broken frame",
  }));
  expect(response.status).toBe(400);
  expect(mocks.getModelInfo).not.toHaveBeenCalled();
});

it("records an invalid model as a caller error", async () => {
  mocks.getModelInfo.mockResolvedValue({});
  const response = await handleChat(new Request("http://localhost/v1/chat/completions", {
    method: "POST", body: JSON.stringify({ model: "unknown-model", messages: [] }),
  }));
  expect(response.status).toBe(400);
  expect(mocks.appendRequestLog).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: "client", message: "Invalid model format" }));
});

it("records missing provider credentials as a router error", async () => {
  const response = await handleChat(new Request("http://localhost/v1/chat/completions", {
    method: "POST", headers: { "x-session-id": "session-a" }, body: JSON.stringify({ model: "test-model", messages: [] }),
  }));
  expect(response.status).toBe(503);
  expect(mocks.appendRequestLog).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: "router", status: "FAILED 503" }));
});

it.each([null, "Bearer invalid-secret"])("records caller authentication failure with header %s", async (authorization) => {
  mocks.getSettings.mockResolvedValue({ requireApiKey: true });
  const response = await handleChat(new Request("http://localhost/v1/chat/completions", {
    method: "POST", headers: authorization ? { authorization } : {}, body: JSON.stringify({ model: "test-model" }),
  }));
  expect(response.status).toBe(401);
  expect(mocks.appendRequestLog).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: "client", status: "FAILED 401" }));
  expect(JSON.stringify(mocks.appendRequestLog.mock.calls)).not.toContain("invalid-secret");
});
