// NVIDIA's OpenAI-style catalog includes embeddings and reward models, too.
// Keep those out of the dashboard's chat model list and completion probes.
export function parseNvidiaModels(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  return rows.flatMap(model => {
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const kind = /embed|nvclip/i.test(id) ? "embedding"
      : /rerank/i.test(id) ? "rerank"
      : /-reward$/i.test(id) ? "reward" : "llm";
    return [{ id, name: model.name || id, kind }];
  });
}
