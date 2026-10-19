import { createHash } from "node:crypto";
import { deleteMeta, getMeta, setMeta } from "@/lib/db/helpers/metaStore.js";
import { extractClientSessionId } from "open-sse/utils/sessionManager.js";

export function getSessionRoutingKey(headers, body, callerId) {
  // Request IDs and prompt-content hashes cannot identify a whole conversation.
  const sessionId = extractClientSessionId(headers, body, "", true);
  if (!sessionId) return null;
  return createHash("sha256").update(JSON.stringify([callerId || "local", sessionId])).digest("hex");
}

export async function getSessionBinding(key) {
  if (!key) return null;
  const value = await getMeta(`chat-session:${key}`);
  return value ? JSON.parse(value) : null;
}

export async function bindSession(key, provider, connectionId) {
  // Called under the account-selection mutex. Keep bindings across restarts.
  await setMeta(`chat-session:${key}`, JSON.stringify({ provider, connectionId }));
}

export async function clearSessionBinding(key) {
  if (!key) return;
  await deleteMeta(`chat-session:${key}`);
}
