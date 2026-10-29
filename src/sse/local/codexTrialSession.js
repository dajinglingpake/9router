import { randomBytes } from "node:crypto";
import { getProviderConnectionById, getSettings } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { DEFAULT_ACCOUNT_COOLDOWN_MIN_MS, DEFAULT_ACCOUNT_COOLDOWN_MAX_MS } from "open-sse/config/errorConfig.js";
import { waitForAccountRequest } from "../services/concurrencyLimiter.js";
import { extractClientApiKey } from "../services/keyAccess.js";
import { getCodexRoutingPolicy } from "./routingPolicy.js";
import { getAccountQuotaState, loadCodexQuotaSnapshot } from "./quotaRouting.js";

// Only dashboard-created jobs can pin an account. Never trust a client-supplied account id.
const sessions = globalThis.__ninerouterCodexTrialSessions ||= new Map();
const PREFIX = "9r-trial-";

export function createTrialSession(connectionId, model, effort, provider = "codex") {
  const token = PREFIX + randomBytes(32).toString("hex");
  // The trial runner revokes this in its finally block on completion, failure or cancellation.
  const session = { connectionId, provider, model, effort, requests: 0, errors: 0, models: new Set() };
  sessions.set(token, session);
  return { token, session, revoke: () => sessions.delete(token) };
}

export function getTrialSession(request) {
  return sessions.get(extractClientApiKey(request)) || null;
}

export function isTrialToken(request) {
  return extractClientApiKey(request)?.startsWith(PREFIX) || false;
}

export async function getTrialCredentials(session) {
  const connection = await getProviderConnectionById(session.connectionId);
  if (!connection || connection.provider !== (session.provider || "codex")) return null;
  if (connection.provider === "openai" && !connection.apiKey) return null;
  if (connection.provider === "codex") {
    const policy = getCodexRoutingPolicy(await getSettings());
    const quota = getAccountQuotaState(connection, session.model, await loadCodexQuotaSnapshot(connection), policy);
    if (quota.exhausted) return {
      sessionUnavailable: true, lastErrorCode: 429,
      lastError: "试用账号套餐额度已用尽，且未允许使用可用 credits，或账号仍处于额度冷却期。",
      retryAfter: quota.retryAt,
    };
  }
  const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
  const { openaiAdminKey, ...modelConnection } = connection;
  return {
    ...modelConnection,
    copilotToken: connection.providerSpecificData?.copilotToken,
    connectionId: connection.id,
    connectionName: connection.displayName || connection.name || connection.email || connection.id,
    routingModel: session.model,
    providerSpecificData: {
      ...connection.providerSpecificData,
      connectionProxyEnabled: proxy.connectionProxyEnabled,
      connectionProxyUrl: proxy.connectionProxyUrl,
      connectionNoProxy: proxy.connectionNoProxy,
      connectionProxyPoolId: proxy.proxyPoolId || null,
      vercelRelayUrl: proxy.vercelRelayUrl || "",
      strictProxy: proxy.strictProxy === true,
    },
    maxConcurrency: connection.maxConcurrency || 0,
    accountCooldownMinMs: Number(connection.accountCooldownMinMs) || DEFAULT_ACCOUNT_COOLDOWN_MIN_MS,
    accountCooldownMaxMs: Number(connection.accountCooldownMaxMs) || DEFAULT_ACCOUNT_COOLDOWN_MAX_MS,
    beforeUpstreamRequest: ({ signal } = {}) => waitForAccountRequest({
      id: connection.id, signal,
      minIntervalMs: Number(connection.minRequestIntervalMs) || 0,
      maxIntervalMs: Number(connection.maxRequestIntervalMs) || Number(connection.minRequestIntervalMs) || 0,
    }),
    _connection: modelConnection,
  };
}

// Count failed HTTP requests / Responses streams once, including CLI retries.
export function trackTrialResponse(session, response) {
  session.requests++;
  let failed = false;
  const fail = () => { if (!failed) { session.errors++; failed = true; } };
  if (!response.ok) fail();
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response;
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  const consume = () => {
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const lines = frame.split(/\r?\n/);
      const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        const event = JSON.parse(data);
        const type = lines.find(line => line.startsWith("event:"))?.slice(6).trim() || event.type;
        if (["error", "response.failed", "response.incomplete"].includes(type) || event.error || event.response?.error
          || ["failed", "incomplete"].includes(event.response?.status)) fail();
        if (["response.completed", "response.done"].includes(type) || event.response?.status === "completed") {
          completed = true;
          if (event.response?.model) session.models.add(event.response.model);
        }
      } catch { /* Ignore unrelated SSE frames. */ }
    }
    if (buffer.length > 4 * 1024 * 1024) buffer = "";
  };
  const reader = response.body.getReader();
  return new Response(new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode() + "\n\n";
          consume();
          if (!completed) fail();
          controller.close();
          reader.releaseLock();
        } else {
          buffer += decoder.decode(value, { stream: true });
          consume();
          controller.enqueue(value);
        }
      } catch (error) { if (!completed) fail(); controller.error(error); }
    },
    cancel(reason) { if (!completed) fail(); return reader.cancel(reason); },
  }), { status: response.status, headers: response.headers });
}
