import { describe, it, expect, vi, beforeEach } from "vitest";

const saveRequestUsage = vi.fn(() => Promise.resolve());

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestUsage,
  appendRequestLog: vi.fn(),
  saveRequestDetail: vi.fn(),
}));

describe("saveUsageStats", () => {
  beforeEach(() => {
    saveRequestUsage.mockClear();
  });

  it("preserves cache and reasoning token details when saving usage", async () => {
    const { saveUsageStats } = await import("../../open-sse/handlers/chatCore/requestDetail.js");

    saveUsageStats({
      provider: "openai",
      model: "gpt-5.3-codex",
      connectionId: "conn-1",
      apiKey: "key-1",
      endpoint: "/v1/chat/completions",
      clientIp: "127.0.0.1",
      tokens: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        prompt_tokens_details: {
          cached_tokens: 300,
          cache_creation_tokens: 40,
        },
        completion_tokens_details: {
          reasoning_tokens: 50,
        },
      },
    });

    expect(saveRequestUsage).toHaveBeenCalledTimes(1);
    expect(saveRequestUsage.mock.calls[0][0]).toMatchObject({
      provider: "openai",
      model: "gpt-5.3-codex",
      connectionId: "conn-1",
      apiKey: "key-1",
      endpoint: "/v1/chat/completions",
      clientIp: "127.0.0.1",
      tokens: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        cached_tokens: 300,
        cache_creation_input_tokens: 40,
        reasoning_tokens: 50,
        prompt_tokens_details: {
          cached_tokens: 300,
          cache_creation_tokens: 40,
        },
        completion_tokens_details: {
          reasoning_tokens: 50,
        },
      },
    });
  });
});
