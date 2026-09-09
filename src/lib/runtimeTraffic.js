// In-memory traffic counters for the runtime monitor. Nothing is persisted.
const state = global._runtimeTraffic || {
  uploadBytes: 0,
  downloadBytes: 0,
  samples: [],
  active: new Map(),
};
global._runtimeTraffic = state;

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

export function getTrafficSnapshot() {
  const now = Date.now();
  const cutoff = now - 10_000;
  state.samples = state.samples.filter((sample) => sample.now >= cutoff);
  const uploadWindow = state.samples.reduce((sum, sample) => sum + sample.uploadBytes, 0);
  const downloadWindow = state.samples.reduce((sum, sample) => sum + sample.downloadBytes, 0);
  return {
    uploadBytes: state.uploadBytes,
    downloadBytes: state.downloadBytes,
    uploadRateBytesPerSecond: Math.round(uploadWindow / 10),
    downloadRateBytesPerSecond: Math.round(downloadWindow / 10),
  };
}

export function getRequestTraffic(requestKey) {
  return state.active.get(requestKey) || { uploadBytes: 0, downloadBytes: 0 };
}

export function clearRequestTraffic(requestKey) {
  if (requestKey) state.active.delete(requestKey);
}
