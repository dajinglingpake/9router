import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSqlJsAdapter } from "../../src/lib/db/adapters/sqljsAdapter.js";
import { TABLES, buildCreateTableSql } from "../../src/lib/db/schema.js";

const state = vi.hoisted(() => ({ db: null }));
vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: async () => state.db }));
vi.mock("@/lib/localDb", () => ({ getProviderConnections: async () => [{ id: "a", name: "Account A" }] }));
import { saveRequestError, getRequestErrors, markRequestErrorsRecovered, clearRequestErrors, getRecentRequestErrorCount } from "../../src/lib/db/repos/requestErrorsRepo.js";
import { GET, DELETE } from "../../src/app/api/system/errors/route.js";

let tempDir, file;
beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-errors-"));
  file = path.join(tempDir, "errors.sqlite");
  state.db = await createSqlJsAdapter(file);
  for (const [name, def] of Object.entries(TABLES)) state.db.exec(buildCreateTableSql(name, def));
});
afterEach(async () => {
  await globalThis._requestErrorWrites.pending;
  state.db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
const error = { provider: "codex", model: "sol", connectionId: "a", status: "FAILED 503", transient: true, requestId: "r1", message: "server_is_overloaded" };

it("preserves a final router timeout even when its upstream attempt was already logged", async () => {
  await saveRequestError(error);
  await saveRequestError({ ...error, source: "router", transient: false, timeoutRemainingMs: 0,
    message: "等待重试已超时" });
  const result = await getRequestErrors();
  expect(result.total).toBe(2);
  expect(result.items[0]).toMatchObject({ source: "router", transient: false, timeoutRemainingMs: 0 });
});

it("retains sanitized errors and recovery across DB reopen, including records older than five minutes", async () => {
  const caller = { apiKeyId: "caller-1", apiKeyName: "已删除的调用方", apiKeyMasked: "test...1234", clientIp: "192.0.2.10", userAgent: "test-cli/1.0", requestedModel: "client-alias", upstreamModel: "sol", thinkingLevel: "high", stream: false, requestBytes: 2048, sourceFormat: "openai-responses", targetFormat: "openai-responses", startedAt: Date.now() - 601500, latencyMs: 1500, queuedAt: Date.now() - 602000, waitMs: 500, position: 1, timeoutRemainingMs: 0, cooldownRemainingMs: 30000, state: "cooldown" };
  const attachments = { estimatedAttachmentTokens: 100, attachmentCount: 2, unestimatedAttachmentCount: 1, encryptedContextCount: 1, inputTokenEstimateVersion: 2 };
  const saved = saveRequestError({ ...error, ...caller, ...attachments, estimatedInputTokens: 900, timestamp: Date.now() - 600000, apiKey: "secret", headers: { authorization: "Bearer secret", "x-request-id": "up-1" } });
  await markRequestErrorsRecovered([saved], { input_tokens: 800, output_tokens: 40 });
  state.db.close();
  state.db = await createSqlJsAdapter(file);
  const result = await getRequestErrors();
  expect(result.total).toBe(1);
  expect(result.items[0]).toMatchObject({ message: "server_is_overloaded", recovered: true, headers: { "x-request-id": "up-1" } });
  expect(result.items[0]).not.toHaveProperty("apiKey");
  expect(result.items[0]).toMatchObject(caller);
  expect(result.items[0]).toMatchObject(attachments);
  expect(result.items[0]).toMatchObject({ estimatedInputTokens: 900, inputTokens: null, outputTokens: null, recoveredUsage: { inputTokens: 800, outputTokens: 40 } });
  expect(state.db.get("SELECT data FROM requestErrors").data).not.toContain("secret");
  expect(await getRecentRequestErrorCount()).toBe(0);
});

it("paginates without duplicates and clears only matching records from the opened snapshot", async () => {
  const first = await saveRequestError(error);
  await saveRequestError({ ...error, requestId: "r2" });
  await saveRequestError({ ...error, connectionId: "b" });
  const page = await getRequestErrors({ connectionId: "a", limit: 1 });
  expect(page.total).toBe(2);
  const next = await getRequestErrors({ connectionId: "a", beforeId: page.nextBeforeId, limit: 1 });
  expect(next.items.map(item => item.id)).toEqual([first]);
  const fresh = await saveRequestError({ ...error, requestId: "new-after-open" });
  const result = await clearRequestErrors({ connectionId: "a", beforeId: page.beforeId });
  expect(result.deleted).toBe(2);
  await markRequestErrorsRecovered([Promise.resolve(first)]);
  const remaining = await getRequestErrors();
  expect(remaining.total).toBe(2);
  expect(remaining.items.map(item => item.requestId)).toContain("new-after-open");
  expect(remaining.items.some(item => item.id === fresh)).toBe(true);
  expect(remaining.items.some(item => item.id === first)).toBe(false);
});

it("deduplicates outer 503 summaries and keeps statistics when logs are cleared", async () => {
  state.db.run(`INSERT INTO usageDaily(dateKey, data) VALUES(?, ?)`, ["2026-09-15", '{"requests":42}']);
  await saveRequestError(error);
  expect(await saveRequestError({ ...error, transient: false })).toBeNull();
  const page = await getRequestErrors();
  expect(page.total).toBe(1);
  await clearRequestErrors({ beforeId: page.beforeId });
  expect((await getRequestErrors()).total).toBe(0);
  expect(state.db.get(`SELECT data FROM usageDaily`).data).toBe('{"requests":42}');
});

it("requires an explicit clear boundary and confirmation, and serves account labels", async () => {
  await saveRequestError({ ...error, apiKeyName: "客户端甲", clientIp: "192.0.2.10" });
  const get = await GET(new Request("http://localhost/api/system/errors?connectionId=a"));
  const result = await get.json();
  expect(result.items[0].account).toBe("Account A");
  expect(result.items[0]).toMatchObject({ apiKeyName: "客户端甲", clientIp: "192.0.2.10" });
  const request = body => new Request("http://localhost/api/system/errors", { method: "DELETE", body: JSON.stringify(body) });
  expect((await DELETE(request({ beforeId: result.beforeId }))).status).toBe(400);
  expect((await DELETE(request({ confirmed: true }))).status).toBe(400);
  const cleared = await DELETE(request({ confirmed: true, beforeId: result.beforeId, connectionId: "a" }));
  expect(await cleared.json()).toEqual({ deleted: 1 });
});
