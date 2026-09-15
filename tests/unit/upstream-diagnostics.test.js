import { expect, it } from "vitest";
import { upstreamResponseDiagnostics, safeDiagnosticMessage, sseErrorDiagnostics } from "../../open-sse/utils/upstreamDiagnostics.js";

it("keeps upstream request ids and rate-limit headers without logging credentials", () => {
  const result = upstreamResponseDiagnostics(new Response(null, { status: 200, headers: {
    "x-request-id": "upstream-123", "retry-after": "30", "x-ratelimit-remaining-requests": "0",
    "set-cookie": "secret-cookie", authorization: "Bearer secret-token",
  } }));
  expect(result).toEqual({ upstreamStatus: 200, headers: {
    "x-request-id": "upstream-123", "retry-after": "30", "x-ratelimit-remaining-requests": "0",
  } });
});

it("extracts only error fields from SSE, not conversation output", () => {
  const text = 'data: {"response":{"output":[{"text":"private output"}],"error":{"code":"server_is_overloaded","type":"server_error","message":"busy","debug":"private debug"}}}\n';
  expect(sseErrorDiagnostics(text)).toEqual({ code: "server_is_overloaded", type: "server_error", message: "busy" });
  expect(sseErrorDiagnostics('data: {"delta":"private output"}\n')).toBeNull();
});

it("redacts secrets and limits diagnostic text", () => {
  expect(safeDiagnosticMessage("Bearer sensitive sk-secret https://user:password@proxy.invalid/path"))
    .toBe("Bearer [REDACTED] [REDACTED] [URL]");
  expect(safeDiagnosticMessage("a".repeat(3000))).toHaveLength(2000);
});
