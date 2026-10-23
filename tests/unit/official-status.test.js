import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { getAccountOfficialReference, incidentMentionsProvider, normalizeOfficialStatus } from "../../src/shared/utils/officialStatus.js";

vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";

const now = Date.parse("2026-10-23T10:00:00Z");
const summary = { status: { indicator: "none", description: "All Systems Operational" } };
const components = { components: ["Codex API", "CLI", "Responses", "Chat Completions"].map(name => ({ id: name, name, status: "operational" })) };
const incident = { id: "incident-1", name: "Elevated errors in Codex", status: "resolved",
  created_at: "2026-10-23T08:00:00Z", resolved_at: "2026-10-23T09:00:00Z" };
const snapshot = (events = [incident]) => normalizeOfficialStatus(summary, components, { incidents: events }, new Date(now).toISOString());
const reference = (data, start, end) => getAccountOfficialReference(data, "codex", start, end, now);

describe("official status account references", () => {
  it("matches resolved incidents only in the test window, independently of current service health", () => {
    const matching = reference(snapshot(), "2026-10-23T08:30:00Z", "2026-10-23T09:00:00Z");
    expect(matching.current).toBe("operational");
    expect(matching.incidents).toHaveLength(1);
    expect(reference(snapshot(), "2026-10-23T09:00:01Z", now).incidents).toEqual([]);
    expect(reference(snapshot(), "2026-10-23T07:00:00Z", "2026-10-23T07:59:59Z").incidents).toEqual([]);
  });

  it("uses published update times for incidents entered retrospectively", () => {
    const data = snapshot([{ ...incident, created_at: "2026-10-24T08:00:00Z", incident_updates: [
      { display_at: "2026-10-23T07:30:00Z", status: "investigating" },
    ] }]);
    expect(reference(data, "2026-10-23T07:40:00Z", "2026-10-23T07:50:00Z").incidents).toHaveLength(1);
  });

  it("does not associate unrelated products, support delays or providers", () => {
    for (const name of ["Customer support delays", "Responses API errors", "ChatGPT Image errors"]) {
      expect(incidentMentionsProvider({ name }, "codex")).toBe(false);
    }
    expect(incidentMentionsProvider({ name: "FedRAMP API errors" }, "openai")).toBe(false);
    expect(incidentMentionsProvider({ name: "Elevated Responses API errors" }, "openai")).toBe(true);
    expect(getAccountOfficialReference(snapshot(), "claude", now, now, now)).toBeNull();
  });

  it("does not turn missing components, stale data or failed fetches into healthy service status", () => {
    for (const data of [null, { ...snapshot(), stale: true }, { ...snapshot(), components: [] },
      { ...snapshot(), fetchedAt: new Date(now - 181_000).toISOString() },
      { ...snapshot(), components: components.components.map(item => ({ ...item, status: "unknown" })) }]) {
      expect(reference(data, now, now).current).toBe("unknown");
    }
    const data = snapshot();
    data.components = data.components.map(item => item.name === "CLI" ? { ...item, status: "partial_outage" } : item);
    expect(reference(data, now, now).current).toBe("incident");
    expect(getAccountOfficialReference(data, "openai", now, now, now).current).toBe("operational");
  });

  it("requires valid test times and bounded incident times", () => {
    for (const [start, end] of [[null, null], ["invalid", now], [now, now - 1]]) {
      expect(reference(snapshot(), start, end)).toMatchObject({ hasWindow: false, incidents: [] });
    }
    const missingEnd = snapshot([{ ...incident, resolved_at: null }]);
    expect(reference(missingEnd, "2026-10-23T08:30:00Z", now).incidents).toEqual([]);
    const active = snapshot([{ ...incident, status: "investigating", resolved_at: null }]);
    expect(reference(active, "2026-10-23T09:30:00Z", now).incidents).toHaveLength(1);
    expect(reference(active, now + 1, now + 1000).incidents).toEqual([]);
  });

  it("preserves finite history bounds without asserting completeness", () => {
    const data = snapshot();
    expect(data.historyCount).toBe(1);
    expect(data.historyOldestAt).toBe(Date.parse(incident.created_at));
    expect(normalizeOfficialStatus(summary, components, { incidents: [] }, now).historyOldestAt).toBeNull();
    expect(() => normalizeOfficialStatus(summary, {}, { incidents: [] }, now)).toThrow();
    expect(() => normalizeOfficialStatus({}, components, { incidents: [] }, now)).toThrow();
  });
});

describe("official status feed cache", () => {
  beforeEach(() => {
    vi.resetModules();
    proxyAwareFetch.mockReset();
    vi.spyOn(Date, "now").mockReturnValue(now);
    proxyAwareFetch.mockImplementation(async url => ({ ok: true, json: async () =>
      url.endsWith("summary.json") ? summary : url.endsWith("components.json") ? components : { incidents: [incident] } }));
  });
  afterEach(() => vi.restoreAllMocks());

  it("shares one public fetch across concurrent accounts and caches it for 60 seconds", async () => {
    const { getOfficialStatus } = await import("../../src/lib/officialStatus.js");
    const [first, second] = await Promise.all([getOfficialStatus(), getOfficialStatus()]);
    expect(first).toEqual(second);
    expect(first.stale).toBe(false);
    await getOfficialStatus();
    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);
    for (const [url, options] of proxyAwareFetch.mock.calls) {
      expect(url).toMatch(/^https:\/\/status\.openai\.com\/api\/v2\//);
      expect(options.headers).toEqual({ Accept: "application/json" });
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("retains timestamped stale history on failure, throttles retry and recovers", async () => {
    const { getOfficialStatus } = await import("../../src/lib/officialStatus.js");
    const first = await getOfficialStatus();
    Date.now.mockReturnValue(now + 61_000);
    proxyAwareFetch.mockResolvedValueOnce({ ok: false });
    const failed = await getOfficialStatus();
    expect(failed).toMatchObject({ stale: true, fetchedAt: first.fetchedAt, incidents: first.incidents });
    await getOfficialStatus();
    expect(proxyAwareFetch).toHaveBeenCalledTimes(6);
    Date.now.mockReturnValue(now + 122_000);
    expect((await getOfficialStatus()).stale).toBe(false);
  });

  it("returns unavailable on initial network or schema failure", async () => {
    const { getOfficialStatus } = await import("../../src/lib/officialStatus.js");
    proxyAwareFetch.mockRejectedValue(new Error("offline"));
    expect(await getOfficialStatus()).toMatchObject({ stale: true, fetchedAt: null, incidents: [] });
    Date.now.mockReturnValue(now + 61_000);
    proxyAwareFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    expect(await getOfficialStatus()).toMatchObject({ stale: true, fetchedAt: null });
  });
});
