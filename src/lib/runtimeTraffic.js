// In-memory traffic counters for the runtime monitor. Nothing is persisted.
const state = global._runtimeTraffic || {
  uploadBytes: 0,
  downloadBytes: 0,
  samples: [],
  active: new Map(),
  outputStreams: new Map(),
};
global._runtimeTraffic = state;
state.outputStreams ||= new Map();

function addSample(uploadBytes, downloadBytes) {
  const now = Date.now();
  state.samples.push({ now, uploadBytes, downloadBytes });
  const cutoff = now - 10_000;
  state.samples = state.samples.filter((sample) => sample.now >= cutoff);
}

export function recordTraffic({ direction, bytes = 0, requestKey = null } = {}) {
  const amount = Math.max(0, Number(bytes) || 0);
  if (!amount || !["upload", "download"].includes(direction)) return;
  if (direction === "upload") state.uploadBytes += amount;
  else state.downloadBytes += amount;
  addSample(direction === "upload" ? amount : 0, direction === "download" ? amount : 0);
  if (requestKey) {
    const current = state.active.get(requestKey) || { uploadBytes: 0, downloadBytes: 0 };
    current[`${direction}Bytes`] += amount;
    state.active.set(requestKey, current);
  }
}

// Streaming text is converted to an approximate token count for live display.
export function recordOutputText(text, streamId) {
  if (typeof text !== "string" || !text) return;
  const stream = state.outputStreams.get(streamId);
  if (!stream) return;
  const now = Date.now();
  stream.tokens += Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
  stream.firstAt ||= now;
  stream.lastAt = now;
}

export function recordOutputChunk(value, streamId) {
  const raw = typeof value === "string" ? value : new TextDecoder().decode(value);
  for (const line of raw.split("\n")) {
    const payload = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (!payload || payload === "[DONE]") continue;
    try {
      const item = JSON.parse(payload);
      const texts = [
        item.choices?.[0]?.delta?.content,
        item.choices?.[0]?.delta?.reasoning_content,
        item.delta?.text,
        item.delta?.thinking,
        typeof item.delta === "string" ? item.delta : null,
        ...(item.candidates?.[0]?.content?.parts || []).map((part) => part?.text),
      ];
      for (const text of texts) recordOutputText(text, streamId);
    } catch {}
  }
}

export function beginOutputStream() {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  state.outputStreams.set(id, { tokens: 0, firstAt: null, lastAt: null });
  return id;
}
export function endOutputStream(id) {
  const stream = state.outputStreams.get(id);
  if (stream) stream.endedAt = Date.now();
}

export function getTrafficSnapshot() {
  const now = Date.now();
  const cutoff = now - 10_000;
  state.samples = state.samples.filter((sample) => sample.now >= cutoff);
  const uploadWindow = state.samples.reduce((sum, sample) => sum + sample.uploadBytes, 0);
  const downloadWindow = state.samples.reduce((sum, sample) => sum + sample.downloadBytes, 0);
  let outputTokensPerSecond = 0;
  for (const [id, stream] of state.outputStreams) {
    if (stream.endedAt && now - stream.endedAt > 10_000) {
      state.outputStreams.delete(id);
      continue;
    }
    if (stream.firstAt && stream.tokens > 0) {
      const elapsedMs = Math.max(1000, (stream.endedAt || now) - stream.firstAt);
      outputTokensPerSecond += stream.tokens / (elapsedMs / 1000);
    }
  }
  return {
    uploadBytes: state.uploadBytes,
    downloadBytes: state.downloadBytes,
    uploadRateBytesPerSecond: Math.round(uploadWindow / 10),
    downloadRateBytesPerSecond: Math.round(downloadWindow / 10),
    outputTokensPerSecond: Math.round(outputTokensPerSecond * 10) / 10,
  };
}

export function getRequestTraffic(requestKey) {
  return state.active.get(requestKey) || { uploadBytes: 0, downloadBytes: 0 };
}

export function clearRequestTraffic(requestKey) {
  if (requestKey) state.active.delete(requestKey);
}
