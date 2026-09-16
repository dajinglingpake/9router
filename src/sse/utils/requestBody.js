import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";
import { CHAT_REQUEST_BODY_LIMITS, HTTP_STATUS } from "open-sse/config/runtimeConfig.js";

// Keep the ordinary JSON path unchanged; Codex's native endpoint also accepts zstd.
export async function readChatRequestBody(request) {
  const encoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (!encoding || encoding === "identity") return request.json();
  if (encoding !== "zstd" || typeof zlib.createZstdDecompress !== "function") {
    throw Object.assign(new Error(`Unsupported Content-Encoding: ${encoding}`), {
      status: HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE,
    });
  }
  const tooLarge = () => Object.assign(new Error("Request body too large"), {
    status: HTTP_STATUS.PAYLOAD_TOO_LARGE,
  });
  const chunks = [];
  let decodedBytes = 0;
  await pipeline(
    Readable.fromWeb(request.body),
    async function* (source) {
      let compressedBytes = 0;
      for await (const chunk of source) {
        compressedBytes += chunk.length;
        if (compressedBytes > CHAT_REQUEST_BODY_LIMITS.compressedBytes) throw tooLarge();
        yield chunk;
      }
    },
    zlib.createZstdDecompress(),
    async (source) => {
      for await (const chunk of source) {
        decodedBytes += chunk.length;
        if (decodedBytes > CHAT_REQUEST_BODY_LIMITS.decodedBytes) throw tooLarge();
        chunks.push(chunk);
      }
    },
    { signal: request.signal },
  );
  return JSON.parse(Buffer.concat(chunks, decodedBytes).toString("utf8"));
}
