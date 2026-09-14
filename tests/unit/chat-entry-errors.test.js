import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendRequestLog: vi.fn().mockResolvedValue(),
  getSettings: vi.fn(),
  isValidApiKey: vi.fn(),
  getModelInfo: vi.fn(),
}));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/usageDb.js", () => ({ appendRequestLog: mocks.appendRequestLog }));
vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getApiKeyByValue: async () => null,
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
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: vi.fn() }));
vi.mock("../../src/sse/utils/logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn(), maskKey: () => "masked",
}));

import { handleChat } from "../../src/sse/handlers/chat.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({ requireApiKey: false });
  mocks.isValidApiKey.mockResolvedValue(false);
  mocks.getModelInfo.mockResolvedValue({ provider: "test", model: "test-model" });
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

it("records an invalid model as a caller error", async () => {
  mocks.getModelInfo.mockResolvedValue({});
  const response = await handleChat(new Request("http://localhost/v1/chat/completions", {
    method: "POST", body: JSON.stringify({ model: "unknown-model", messages: [] }),
  }));
  expect(response.status).toBe(400);
  expect(mocks.appendRequestLog).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: "client", message: "Invalid model format" }));
});

it("records missing provider credentials as a router error even though the status is 404", async () => {
  const response = await handleChat(new Request("http://localhost/v1/chat/completions", {
    method: "POST", body: JSON.stringify({ model: "test-model", messages: [] }),
  }));
  expect(response.status).toBe(404);
  expect(mocks.appendRequestLog).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: "router", status: "FAILED 404" }));
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
