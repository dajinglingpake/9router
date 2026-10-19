// Render the CLI's public JSONL events as readable output, retaining incremental item updates.
export function createTrialOutputFormatter() {
  const items = new Map();
  return event => {
    if (event.type === "thread.started") return { text: "[会话] Codex 会话已建立。", activity: "会话已建立" };
    if (event.type === "turn.started") return { text: "[请求] 已开始执行，等待模型输出。", activity: "等待模型输出" };
    if (event.type === "turn.completed") return { text: "[完成] Codex 已完成本轮执行，正在读取生成文件。", activity: "正在读取生成文件" };
    if (event.type === "error" || event.type === "turn.failed") return { text: `[错误] ${event.message || event.error?.message || "执行失败"}`, activity: "收到执行错误" };
    const item = event.item;
    if (!item || !["item.started", "item.updated", "item.completed"].includes(event.type)) return null;
    const previous = items.get(item.id) || {};
    items.set(item.id, item);
    if (items.size > 256) items.delete(items.keys().next().value);
    const delta = (value, oldValue) => typeof value === "string" ? value.startsWith(oldValue || "") ? value.slice((oldValue || "").length) : value : "";
    if (item.type === "agent_message" || item.type === "reasoning") {
      const text = delta(item.text, previous.text);
      return text ? { text, activity: item.type === "agent_message" ? "Codex 正在输出" : "Codex 正在处理请求" } : null;
    }
    if (item.type === "command_execution") {
      const lines = [];
      if (!previous.command) lines.push(`[命令] ${item.command || "执行工具"}`);
      const output = delta(item.aggregated_output, previous.aggregated_output);
      if (output) lines.push(output);
      if (event.type === "item.completed") lines.push(`[命令结束] 退出码 ${item.exit_code ?? "未知"}`);
      return { text: lines.join("\n"), activity: event.type === "item.completed" ? "命令已结束，等待下一步" : "正在执行命令" };
    }
    if (item.type === "file_change") return {
      text: `[文件] ${(item.changes || []).map(change => `${change.kind || "修改"} ${change.path}`).join("、") || "更新工作目录"} · ${item.status || event.type}`,
      activity: "正在写入文件",
    };
    if (item.type === "error") return { text: `[错误] ${item.message || "工具执行失败"}`, activity: "收到工具错误" };
    return null;
  };
}

export function formatTrialLog(log = "") {
  const format = createTrialOutputFormatter();
  return log.split("\n").flatMap(line => {
    if (!line.trim()) return [];
    try { const event = format(JSON.parse(line)); return event?.text ? [event.text] : []; }
    catch { return [line]; }
  }).join("\n\n");
}
