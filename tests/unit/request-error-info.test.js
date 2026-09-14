import { expect, it } from "vitest";
import { getRequestErrorInfo } from "../../src/lib/requestErrorInfo.js";

it.each([
  ["client", 400, "Missing model", "client", "请求参数缺少模型"],
  ["client", 401, "Invalid API key", "client", "调用密钥无效或已停用"],
  ["upstream", 401, "Unauthorized", "server", "提供商账号凭证失效"],
  ["upstream", 403, "Forbidden", "server", "提供商账号无访问权限"],
  ["upstream", 429, "Rate limited", "server", "上游限流或账号额度不足"],
  ["upstream", 502, "fetch failed", "server", "上游连接失败或响应异常"],
  ["upstream", 413, "Too large", "client", "请求内容过大"],
  ["router", 400, "Failed to translate request", "server", "服务处理失败"],
  ["router", 503, "Concurrency queue wait timed out", "server", "服务端繁忙，排队等待超时"],
  ["router", 499, "Request aborted", "cancelled", "请求已取消"],
  ["upstream", 499, "Request aborted", "cancelled", "请求已取消"],
])("classifies %s %s by origin", (source, status, message, category, summary) => {
  expect(getRequestErrorInfo({ source, status: `FAILED ${status}`, message })).toEqual({ category, summary, statusCode: status });
});

it("does not mistake unrelated digits for an HTTP failure", () => {
  expect(getRequestErrorInfo({ status: "200 OK" })).toBeNull();
  expect(getRequestErrorInfo({ status: "success 14500" })).toBeNull();
  expect(getRequestErrorInfo({ status: "error" })).toMatchObject({ category: "server" });
});
