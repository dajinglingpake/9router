import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/codexTrials/store", () => ({ getTrialRecord: vi.fn() }));
vi.mock("@/lib/requestDiagnostics", async importOriginal => ({ ...await importOriginal(), getRequestDiagnostics: vi.fn() }));
import { getTrialRecord } from "@/lib/codexTrials/store";
import { getRequestDiagnostics } from "@/lib/requestDiagnostics";
import { GET } from "@/app/api/codex-trials/[id]/errors/route.js";

const start = "2026-10-19T08:00:00.000Z", end = "2026-10-19T08:01:00.000Z";
const record = { id: "trial-id", connectionId: "account-id", model: "gpt-6.1-sol", queuedAt: start, startedAt: start, finishedAt: end };
const request = query => new Request(`http://localhost/api/codex-trials/trial-id/errors?${query || ""}`);
const context = { params: Promise.resolve({ id: "trial-id" }) };
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

describe("trial request details", () => {
  it("uses the saved account, model and server timestamps even if the client supplies a different scope", async () => {
    getTrialRecord.mockReturnValue(record);
    getRequestDiagnostics.mockResolvedValue({ details: [], pagination: { total: 0 } });
    const response = await GET(request("focusConnectionId=other&apiKeyId=other&model=other&start=2000-01-01&end=2100-01-01&issue=error&page=2"), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(getRequestDiagnostics).toHaveBeenCalledWith(expect.objectContaining({
      focusConnectionId: "account-id", apiKeyId: "codex-account-test", model: "gpt-6.1-sol", provider: "codex", detailsOnly: true,
      start: Date.parse(start), end: Date.parse(end) + 1000, issue: "error", page: 2,
    }));
  });
  it("opens all outcomes for the request-count link while keeping ordinary account traffic out", async () => {
    getTrialRecord.mockReturnValue(record);
    getRequestDiagnostics.mockResolvedValue({ details: [], pagination: { total: 0 } });
    expect((await GET(request("issue=all"), context)).status).toBe(200);
    expect(getRequestDiagnostics).toHaveBeenCalledWith(expect.objectContaining({ issue: "all", apiKeyId: "codex-account-test" }));
  });
  it("uses server time for an active trial, including one that is still queued", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(end));
    getTrialRecord.mockReturnValue({ ...record, startedAt: null, finishedAt: null });
    getRequestDiagnostics.mockResolvedValue({ details: [], pagination: { total: 0 } });
    expect((await GET(request(), context)).status).toBe(200);
    expect(getRequestDiagnostics).toHaveBeenCalledWith(expect.objectContaining({ start: Date.parse(start), end: Date.parse(end) + 1000 }));
  });
  it("does not query logs for a missing record or invalid page", async () => {
    getTrialRecord.mockReturnValue(null);
    expect((await GET(request(), context)).status).toBe(404);
    getTrialRecord.mockReturnValue(record);
    expect((await GET(request("page=-1"), context)).status).toBe(400);
    expect(getRequestDiagnostics).not.toHaveBeenCalled();
  });
});
