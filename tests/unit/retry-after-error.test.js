import { describe, it, expect } from "vitest";
import { parseUpstreamError } from "../../open-sse/utils/error.js";

describe("parseUpstreamError Retry-After", () => {
  it("exposes the upstream delay as an absolute cooldown", async () => {
    const before = Date.now();
    const response = new Response(JSON.stringify({ error: { message: "temporarily overloaded" } }), {
      status: 503,
      headers: { "Retry-After": "31" },
    });

    const parsed = await parseUpstreamError(response);

    expect(parsed.statusCode).toBe(503);
    expect(parsed.resetsAtMs).toBeGreaterThanOrEqual(before + 31000);
    expect(parsed.resetsAtMs).toBeLessThanOrEqual(Date.now() + 31000);
  });
});
