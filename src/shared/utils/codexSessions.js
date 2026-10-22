export function getCodexDeviceStatus(device) {
  return { active: "本次仍有登录会话", signed_out: "OpenAI 标记已退出", unknown: "会话状态未知" }[device.status] || "会话状态未知";
}
