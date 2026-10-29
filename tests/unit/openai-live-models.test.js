import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn() }));
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { parseOpenAIModels, resolveOpenAIModels } from "@/lib/openaiModels";
import { OPENAI_MODELS_CONFIG } from "open-sse/providers/registry/openai.js";

let sequence = 0;
const account = () => ({ id: `openai-${++sequence}`, apiKey: "secret", providerSpecificData: {} });
beforeEach(() => {
  vi.resetAllMocks();
  proxyAwareFetch.mockImplementation(async () => Response.json({ data: [{ id: "gpt-6.1-terra" }] }));
  resolveConnectionProxyConfig.mockResolvedValue({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.test" });
});
afterEach(() => vi.useRealTimers());

describe("OpenAI live models", () => {
  it("keeps new API models and classifies non-chat models without inventing catalog entries", () => {
    const ids = ["gpt-6.1-terra", "gpt-image-next", "tts-next", "text-embedding-next", "gpt-4o-transcribe", "sora-next", "omni-moderation-latest", "gpt-realtime-next", "davinci-002"];
    const models = parseOpenAIModels({ data: [...ids, ids[0]].map(id => ({ id, privateField: "hidden" })).concat([null, { id: " " }]) });
    expect(models.map(model => model.id)).toEqual(ids);
    expect(models.map(model => model.kind)).toEqual(["llm", "image", "tts", "embedding", "stt", "video", "moderation", "realtime", "completion"]);
    expect(JSON.stringify(models)).not.toContain("hidden");
    expect(parseOpenAIModels({ data: {} })).toEqual([]);
    expect(parseOpenAIModels({ data: [{ id: "gpt-image-1" }] })[0].params).toContain("size");
  });

  it("uses the saved API key and strict account proxy with a timeout", async () => {
    const result = await resolveOpenAIModels(account());
    expect(proxyAwareFetch).toHaveBeenCalledWith(OPENAI_MODELS_CONFIG.url, expect.objectContaining({
      method: "GET", redirect: "error", headers: { Accept: "application/json", Authorization: "Bearer secret" },
      signal: expect.any(AbortSignal),
    }), expect.objectContaining({ connectionProxyUrl: "http://proxy.test", strictProxy: true }));
    expect(result.models[0].id).toBe("gpt-6.1-terra");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("isolates cached accounts, rotated keys and resolved proxies, and supports refresh and expiry", async () => {
    vi.useFakeTimers();
    const conn = account();
    await resolveOpenAIModels(conn);
    await resolveOpenAIModels(conn);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    await resolveOpenAIModels({ ...conn, id: "other" });
    await resolveOpenAIModels({ ...conn, apiKey: "rotated" });
    resolveConnectionProxyConfig.mockResolvedValue({ connectionProxyUrl: "http://changed.test" });
    await resolveOpenAIModels(conn);
    await resolveOpenAIModels(conn, { forceRefresh: true });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(5);
    vi.advanceTimersByTime(OPENAI_MODELS_CONFIG.cacheTtlMs + 1);
    await resolveOpenAIModels(conn);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(6);
  });

  it.each(["http", "empty", "json", "timeout"])("reports %s failures without caching them or exposing credentials", async mode => {
    if (mode === "http") proxyAwareFetch.mockResolvedValueOnce(new Response("secret", { status: 401 }));
    if (mode === "empty") proxyAwareFetch.mockResolvedValueOnce(Response.json({ data: [] }));
    if (mode === "json") proxyAwareFetch.mockResolvedValueOnce(new Response("secret"));
    if (mode === "timeout") proxyAwareFetch.mockRejectedValueOnce(new Error("secret"));
    const conn = account();
    const result = await resolveOpenAIModels(conn);
    expect(result).toMatchObject({ models: [], warning: expect.stringContaining("built-in list") });
    expect(result.warning).not.toContain("secret");
    expect((await resolveOpenAIModels(conn)).models).toHaveLength(1);
  });

  it("does not query upstream without an API key", async () => {
    expect((await resolveOpenAIModels({ id: "no-key" })).models).toEqual([]);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });
});
