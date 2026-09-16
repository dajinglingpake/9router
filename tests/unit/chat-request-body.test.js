import { describe, expect, it, vi } from "vitest";
import { zstdCompressSync } from "node:zlib";

vi.mock("open-sse/config/runtimeConfig.js", async importOriginal => ({
  ...await importOriginal(),
  CHAT_REQUEST_BODY_LIMITS: { compressedBytes: 128, decodedBytes: 256 },
}));
import { readChatRequestBody } from "../../src/sse/utils/requestBody.js";

function request(body, encoding = "zstd") {
  return new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-encoding": encoding }, body,
  });
}

describe("chat request body decoding", () => {
  it.each(["", "identity"])("preserves ordinary JSON with encoding '%s'", async encoding => {
    expect(await readChatRequestBody(request('{"model":"codex/test"}', encoding))).toEqual({ model: "codex/test" });
  });

  it("decodes native zstd JSON and Unicode across streamed chunks", async () => {
    const body = { model: "codex/test", input: "你好", parallel_tool_calls: false };
    const compressed = zstdCompressSync(JSON.stringify(body));
    const stream = new ReadableStream({ start(controller) {
      for (const byte of compressed) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } });
    const req = new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-encoding": " ZSTD " }, body: stream, duplex: "half",
    });
    expect(await readChatRequestBody(req)).toEqual(body);
  });

  it.each([Buffer.from("invalid frame"), zstdCompressSync("not json")])("rejects malformed compressed input", async body => {
    await expect(readChatRequestBody(request(body))).rejects.toThrow();
  });

  it("bounds compressed bytes before decompression", async () => {
    await expect(readChatRequestBody(request(Buffer.alloc(129)))).rejects.toMatchObject({ status: 413 });
  });

  it("bounds expanded bytes for highly compressed payloads", async () => {
    const compressed = zstdCompressSync(JSON.stringify({ input: "a".repeat(1000) }));
    expect(compressed.length).toBeLessThan(128);
    await expect(readChatRequestBody(request(compressed))).rejects.toMatchObject({ status: 413 });
  });

  it("rejects unsupported or stacked encodings explicitly", async () => {
    await expect(readChatRequestBody(request("{}", "zstd, gzip"))).rejects.toMatchObject({ status: 415 });
  });
});
