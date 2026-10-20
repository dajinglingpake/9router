import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/dashboardSession", () => ({ verifyDashboardAuthToken: async token => token === "valid", shouldUseSecureCookie: () => false }));
const originalDataDir = process.env.DATA_DIR;
let directory, history, db, listeners;
const message = (extra = {}) => ({ id: "msg-one", threadId: "thread-one", role: "user", text: "请帮我检查账号", createdAt: "2026-10-20T01:00:00.000Z", complete: true, ...extra });
const snapshot = (messages, extra = {}) => ({ kind: "snapshot", id: "snapshot_1", threadId: "thread-one", messages, full: true, startedAt: Date.now() + 100, ...extra });

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
  it("reconciles regenerated history IDs, repairs legacy duplicates and preserves notes", async () => {
    await history.saveAppealMessages("a", [message(), message({ id: "old-copy" }), message({ id: "reply", role: "support", text: "已转人工" }), message({ id: "reply-copy", role: "support", text: "已转人工" })]);
    await history.updateAppealResult("a", "thread-one", { result: "follow_up", note: "等待邮件" });
    const page = [message({ id: "regenerated-user" }), message({ id: "regenerated-reply", role: "support", text: "已转人工" })];
    await history.saveAppealMessages("a", [snapshot(page)]);
    await history.saveAppealMessages("a", [snapshot(page.map((m, i) => ({ ...m, id: `new-id-${i}`, createdAt: "2026-10-20T02:00:00Z" })))]);
    const record = await history.getAppealHistory("a", "thread-one");
    expect(record).toMatchObject({ messageCount: 2, userMessageCount: 1, result: "follow_up", note: "等待邮件" });
    expect(record.messages.map(m => m.id)).toEqual(["msg-one", "reply"]);
    expect((await history.listAppealHistory("a")).items[0].messageCount).toBe(2);
    expect((await history.getAppealSummaries()).a.latest.messageCount).toBe(2);
    // Repeated loads do not add rows. Original captured records remain recoverable.
    expect(global._dbAdapter.instance.all("SELECT key FROM kv WHERE scope = 'accountAppealMessages'")).toHaveLength(4);
  });

  it("preserves intentional repetitions, conversation order and separate accounts", async () => {
    const page = [message({ id: "first", text: "谢谢" }), message({ id: "reply", role: "support", text: "请稍等" }), message({ id: "second", text: "谢谢" })];
    await history.saveAppealMessages("a", [snapshot(page)]);
    await history.saveAppealMessages("a", [snapshot(page.map(m => ({ ...m, id: `changed-${m.id}` })))]);
    await history.saveAppealMessages("b", [snapshot([message({ id: "other" })])]);
    const record = await history.getAppealHistory("a", "thread-one");
    expect(record).toMatchObject({ messageCount: 3, userMessageCount: 2 });
    expect(record.messages.map(m => m.text)).toEqual(["谢谢", "请稍等", "谢谢"]);
    expect((await history.getAppealHistory("b", "thread-one")).messageCount).toBe(1);
  });

  it("does not lose concurrent live messages, partial history or newer snapshots", async () => {
    await history.saveAppealMessages("a", [message(), message({ id: "new-live", text: "还有一个问题" })]);
    await history.saveAppealMessages("a", [snapshot([message({ id: "fresh-id" })], { startedAt: Date.now() - 1000 })]);
    expect((await history.getAppealHistory("a", "thread-one")).messageCount).toBe(2);
    await history.saveAppealMessages("a", [snapshot([message()], { full: false })]);
    expect((await history.getAppealHistory("a", "thread-one")).messageCount).toBe(2);
    await history.saveAppealMessages("a", [snapshot([], { startedAt: 1 })]);
    expect((await history.getAppealHistory("a", "thread-one")).messageCount).toBe(2);
  });

  it("does not collapse identical messages from different partial history pages", async () => {
    await history.saveAppealMessages("a", [snapshot([message()], { full: false })]);
    await history.saveAppealMessages("a", [snapshot([message({ id: "earlier-repeat" })], { full: false })]);
    expect((await history.getAppealHistory("a", "thread-one")).userMessageCount).toBe(2);
  });

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
    await history.saveAppealMessages("a", [snapshot([message({ id: "regenerated" })])]);
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
