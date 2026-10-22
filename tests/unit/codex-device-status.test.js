import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/providerUsage", () => ({ refreshAndUpdateCredentials: vi.fn() }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn() }));
import { parseCodexDevices } from "@/lib/codexSessions";
import { getCodexDeviceStatus } from "@/shared/utils/codexSessions";

describe("Codex device status semantics", () => {
  it("uses the website's active, remembered signed-out, and unavailable device distinctions", () => {
    const devices = parseCodexDevices({ devices: [
      { session_id: "active", display_name: "Desktop", last_signed_in_timestamp_second: 1792620000, app_sessions: [{ client_name: "ChatGPT" }, { client_name: "ChatGPT" }, { client_name: "Codex" }] },
      { hashed_device_id: "remembered", display_name: "Phone", is_trusted_device: true, can_untrust: true },
      { hashed_device_id: "unavailable", display_name: "Unknown session", is_trusted_device: true, can_untrust: false },
      { hashed_device_id: "current", display_name: "Current", is_trusted_device: true, can_untrust: true, is_current_device: true },
    ] });
    expect(devices.map(device => device.status)).toEqual(["active", "signed_out", "unknown", "active"]);
    expect(devices[0].apps).toEqual(["ChatGPT", "Codex"]);
    expect(devices[0].signedInAt).toBe(new Date(1792620000000).toISOString());
  });

  it("labels only the state returned by OpenAI", () => {
    expect(getCodexDeviceStatus({ status: "active" })).toBe("本次仍有登录会话");
    expect(getCodexDeviceStatus({ status: "signed_out" })).toBe("OpenAI 标记已退出");
    expect(getCodexDeviceStatus({ status: "unknown" })).toBe("会话状态未知");
  });

  it("rejects unusable payloads and invalid timestamps do not crash the parser", () => {
    expect(() => parseCodexDevices({ devices: [{}] })).toThrow();
    expect(parseCodexDevices({ devices: [{ session_id: "a", last_signed_in_timestamp_second: 1e30 }] })[0].signedInAt).toBeNull();
    expect(parseCodexDevices({ devices: [{ session_id: "a" }, { session_id: "a" }] })).toHaveLength(1);
  });
});
