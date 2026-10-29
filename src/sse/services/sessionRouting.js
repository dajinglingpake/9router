import { createHash } from "node:crypto";
import { deleteMeta, getMeta, setMeta } from "@/lib/db/helpers/metaStore.js";
import { extractClientSessionId } from "open-sse/utils/sessionManager.js";

export function getSessionRoutingKey(headers, body, callerId) {
  // Request IDs and prompt-content hashes cannot identify a whole conversation.
  const sessionId = extractClientSessionId(headers, body, "", true);
  if (!sessionId) return null;
  return createHash("sha256").update(JSON.stringify([callerId || "local", sessionId])).digest("hex");
}

export async function getSessionBinding(key, provider) {
  if (!key) return null;
  // A combo may visit several providers in one conversation. Keep account
  // affinity within each provider, without letting it choose the route.
  const value = await getMeta(`chat-session:${key}:${provider}`)
    || await getMeta(`chat-session:${key}`);
  const binding = value ? JSON.parse(value) : null;
  // Reuse pre-upgrade bindings only for their original provider.
  return binding?.provider === provider ? binding : null;
}

export async function bindSession(key, provider, connectionId) {
  // Called under the account-selection mutex. Keep bindings across restarts.
  await setMeta(`chat-session:${key}:${provider}`, JSON.stringify({ provider, connectionId }));
}

export async function clearSessionBinding(key, provider) {
  if (!key) return;
  await deleteMeta(`chat-session:${key}:${provider}`);
  const legacy = await getMeta(`chat-session:${key}`);
  if (legacy && JSON.parse(legacy).provider === provider) {
    await deleteMeta(`chat-session:${key}`);
  }
}
