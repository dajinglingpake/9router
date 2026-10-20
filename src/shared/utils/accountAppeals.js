export const APPEAL_RESULTS = { pending: "处理中", resolved: "已解决", unresolved: "未解决", follow_up: "需跟进" };
export const APPEAL_NOTE_LIMIT = 2000;
export function appealResultLabel(record) {
  return APPEAL_RESULTS[record?.result] || (record?.lastReply ? "已收到回复" : record?.userMessageCount ? "等待回复" : "对话已记录");
}
