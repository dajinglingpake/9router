import { createHash } from "node:crypto";
import { getMeta, setMeta } from "@/lib/db/helpers/metaStore.js";
import { extractClientSessionId } from "open-sse/utils/sessionManager.js";

export const NEW_SESSION_HINT = "当前会话不会自动切换账号。如需使用其他可用账号，请开启新会话。";

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
