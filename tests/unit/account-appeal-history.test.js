import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/dashboardSession", () => ({ verifyDashboardAuthToken: async token => token === "valid", shouldUseSecureCookie: () => false }));
const originalDataDir = process.env.DATA_DIR;
let directory, history, db, listeners;
const message = (extra = {}) => ({ id: "msg-one", threadId: "thread-one", role: "user", text: "请帮我检查账号", createdAt: "2026-10-20T01:00:00.000Z", complete: true, ...extra });

beforeEach(async () => {
  listeners = Object.fromEntries(["beforeExit", "exit", "SIGINT", "SIGTERM"].map(event => [event, new Set(process.rawListeners(event))]));
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "9router-appeal-history-"));
  process.env.DATA_DIR = directory;
  delete global._dbAdapter; vi.resetModules();
  db = await import("@/lib/db/index.js"); await db.initDb();
  history = await import("@/lib/accountAppeals/history.js");
});
afterEach(() => {
  global._dbAdapter?.instance?.close?.(); delete global._dbAdapter;
  for (const [event, original] of Object.entries(listeners)) for (const listener of process.rawListeners(event)) if (!original.has(listener)) process.removeListener(event, listener);
  fs.rmSync(directory, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = originalDataDir;
});

describe("durable appeal history", () => {
  it("isolates accounts, deduplicates messages and preserves results when new replies arrive", async () => {
    await history.saveAppealMessages("account-one", [message(), message()]);
    await history.updateAppealResult("account-one", "thread-one", { result: "follow_up", note: "等待邮件" });
    await history.saveAppealMessages("account-one", [message({ id: "reply", role: "support", text: "已转人工", createdAt: "2026-10-20T01:01:00.000Z" })]);
    await history.saveAppealMessages("account-two", [message({ text: "另一个账号" })]);
    const first = await history.getAppealHistory("account-one", "thread-one");
    expect(first).toMatchObject({ messageCount: 2, userMessageCount: 1, result: "follow_up", note: "等待邮件", lastReply: "已转人工" });
    expect(first.messages).toHaveLength(2);
    expect((await history.getAppealHistory("account-two", "thread-one")).messages[0].text).toBe("另一个账号");
    const summaries = await history.getAppealSummaries();
    expect(summaries["account-one"].count).toBe(1);
    expect(summaries["account-one"].latest.messages).toBeUndefined();
  });

  it("keeps partial replies but does not overwrite a completed message with a late fragment", async () => {
    await history.saveAppealMessages("a", [message({ role: "support", text: "正在", complete: false })]);
    expect((await history.getAppealHistory("a", "thread-one")).messages[0].complete).toBe(false);
    await history.saveAppealMessages("a", [message({ role: "support", text: "正在处理，请等待" })]);
    await history.saveAppealMessages("a", [message({ role: "support", text: "正在", complete: false })]);
    expect((await history.getAppealHistory("a", "thread-one")).messages[0]).toMatchObject({ text: "正在处理，请等待", complete: true });
  });

  it("retains messages and notes across a database restart without storing credential fields", async () => {
    await history.saveAppealMessages("a", [message({ accessToken: "private", headers: { Authorization: "private" } })]);
    await history.updateAppealResult("a", "thread-one", { result: "resolved", note: "恢复正常" });
    expect(JSON.stringify(global._dbAdapter.instance.all("SELECT value FROM kv WHERE scope IN ('accountAppealThreads', 'accountAppealMessages')"))).not.toContain("private");
    global._dbAdapter.instance.close(); delete global._dbAdapter; vi.resetModules();
    db = await import("@/lib/db/index.js"); await db.initDb();
    history = await import("@/lib/accountAppeals/history.js");
    expect(await history.getAppealHistory("a", "thread-one")).toMatchObject({ result: "resolved", note: "恢复正常", messageCount: 1 });
  });

  it("paginates histories and rejects unknown records and invalid edits", async () => {
    for (let i = 0; i < 23; i++) await history.saveAppealMessages("a", [message({ threadId: `thread-${i}`, createdAt: new Date(Date.UTC(2026, 9, 20, 1, i)).toISOString() })]);
    expect(await history.listAppealHistory("a")).toMatchObject({ total: 23, hasMore: true });
    expect((await history.listAppealHistory("a", 20)).items).toHaveLength(3);
    expect((await history.getAppealSummaries()).a.latest.id).toBe("thread-22");
    await expect(history.getAppealHistory("other", "thread-22")).rejects.toMatchObject({ status: 404 });
    await expect(history.updateAppealResult("a", "thread-22", { result: "invalid", note: "" })).rejects.toMatchObject({ status: 400 });
    await expect(history.updateAppealResult("a", "thread-22", { result: null, note: "x".repeat(2001) })).rejects.toMatchObject({ status: 400 });
    await expect(history.listAppealHistory("../other")).rejects.toMatchObject({ status: 400 });
  });

  it("requires dashboard access, permits passwordless reads and rejects cross-origin edits", async () => {
    await history.saveAppealMessages("a", [message()]);
    const { GET, PUT } = await import("@/app/api/account-appeals/history/route.js");
    const req = (token, origin = "http://router.test") => ({ nextUrl: new URL("http://router.test/api/account-appeals/history?connectionId=a"), cookies: { get: () => token ? { value: token } : undefined }, headers: new Headers({ origin, host: "router.test", "content-type": "application/json" }), json: async () => ({ connectionId: "a", threadId: "thread-one", result: "resolved", note: "" }) });
    await db.updateSettings({ requireLogin: true });
    expect((await GET(req(null))).status).toBe(401);
    expect((await GET(req("valid"))).status).toBe(200);
    expect((await PUT(req("valid", "https://unrelated.test"))).status).toBe(403);
    expect((await history.getAppealHistory("a", "thread-one")).result).toBeNull();
    await db.updateSettings({ requireLogin: false });
    expect((await GET(req(null))).status).toBe(200);
    expect((await PUT(req(null))).status).toBe(200);
  });
});
