import { describe, expect, it } from "vitest";
import { appendChatErrorHint } from "@/sse/utils/errorHints.js";

describe("chat error hints", () => {
  it.each([
    [400, '[400]: {"error":{"message":"Missing required parameter: \'input[37].status\'.","type":"invalid_request_error","param":"input[37].status","code":"missing_required_parameter"}}', "请求参数或协议格式错误。"],
    [503, '[503]: {"error":{"message":"Our servers are currently overloaded. Please try again later.","code":"server_is_overloaded"}}', "上游服务过载。"],
    [503, "[503]: upstream connect error or disconnect/reset before headers. reset reason: connection timeout", "连接或响应超时。"],
    [503, "HTTP 503", "服务暂不可用。"],
    [403, "[403]: HTTP 403", "访问权限不足或请求被策略拒绝。"],
    [499, "[ProxyFetch] Proxy required but failed (strictProxy=true): ", "网络或代理连接失败。"],
    [499, "Request aborted while waiting for concurrency slot", "请求已取消。"],
    [429, "usage_limit_reached", "账号额度或余额不足。"],
    [429, "rate_limit_exceeded", "请求频率受限。"],
    [429, "Too many concurrent requests", "并发请求数超过限制。"],
    [429, "Concurrency queue wait timed out", "排队等待超时。"],
    [400, "context_length_exceeded: maximum context length is 128000 tokens", "请求上下文超出模型限制。"],
    [400, "Missing required parameter: 'billing'", "请求参数或协议格式错误。"],
    [413, "Request too large", "请求内容过大。"],
    [415, "Unsupported Content-Encoding: br", "请求内容编码或格式不受支持。"],
    [401, "Missing API key", "身份验证失败，请检查调用密钥或账号登录状态。"],
    [403, "invalid_api_key", "身份验证失败，请检查调用密钥或账号登录状态。"],
    [401, "token_expired", "账号凭证无效或已失效。"],
    [502, "Invalid JSON response from codex", "网关连接失败或上游响应异常。"],
    [507, "HTTP 507", "服务端资源不足。"],
  ])("preserves the raw %i error and appends its specific explanation: %s", (status, message, hint) => {
    expect(appendChatErrorHint(status, message, { source: "upstream" })).toBe(`${message}\n提示：${hint}`);
  });

  it.each([
    [403, "组合“gpt-5.5”已禁用。", "请求的模型或组合已禁用。"],
    [503, "绑定的账号已停用或删除。", "暂无可用账号。"],
    [429, "当前会话绑定的账号额度已用尽。", "账号额度或余额不足。"],
    [409, "当前会话已绑定其他提供商，不能切换。", "当前会话的提供商绑定限制了本次请求。"],
    [503, "账号繁忙，等待重试已超过时限，请稍后重试。", "排队等待超时。"],
  ])("distinguishes router failures from upstream failures: %s %s", (status, message, hint) => {
    expect(appendChatErrorHint(status, message, { source: "router" })).toBe(`${message}\n提示：${hint}`);
  });

  it("uses the network cause to distinguish a timeout from a generic fetch failure", () => {
    expect(appendChatErrorHint(502, "fetch failed", { networkCode: "ETIMEDOUT" }))
      .toBe("fetch failed\n提示：连接或响应超时。");
    expect(appendChatErrorHint(502, "fetch failed", { networkCode: "ECONNRESET" }))
      .toBe("fetch failed\n提示：网络或代理连接失败。");
  });

  it("keeps cooldown advice outside the original error and only for retryable failures", () => {
    const raw = "  Our servers are currently overloaded. Please try again later.\n";
    expect(appendChatErrorHint(503, raw, { retryAfterSeconds: 2.1 }))
      .toBe(`${raw}\n提示：上游服务过载。 请在 3 秒后重试。`);
    for (const [status, message] of [[400, "Missing required parameter: 'input[37].status'"], [401, "Invalid API key"], [403, "HTTP 403"], [499, "Request aborted"]]) {
      expect(appendChatErrorHint(status, message, { retryAfterSeconds: 120 }))
        .toBe(appendChatErrorHint(status, message));
    }
    for (const retryAfterSeconds of [undefined, 0, -1, NaN, Infinity]) {
      expect(appendChatErrorHint(503, raw, { retryAfterSeconds })).toBe(appendChatErrorHint(503, raw));
    }
  });

  it("leaves unrecognized and empty errors unchanged", () => {
    expect(appendChatErrorHint(418, "custom provider error", { retryAfterSeconds: 120 })).toBe("custom provider error");
    expect(appendChatErrorHint(500, "")).toBe("");
  });
});
