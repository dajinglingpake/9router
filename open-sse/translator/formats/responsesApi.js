import { ROLE, OPENAI_BLOCK, RESPONSES_ITEM } from "../schema/index.js";
import { CHAT_TOOL_NAME_MAX_LENGTH } from "../../config/runtimeConfig.js";

// Chat tools share one flat name space. Keep same-name tools from distinct
// Responses namespaces callable, and use the same aliases for history/choices.
export function collectResponsesToolNames(body) {
  const entries = new Map();
  const key = (name, namespace) => JSON.stringify([namespace || "", name]);
  const add = (name, namespace) => {
    if (typeof name !== "string" || !name.trim()) return;
    const id = key(name, namespace);
    if (!entries.has(id)) entries.set(id, { name, namespace });
  };
  const collect = (tools) => {
    for (const tool of Array.isArray(tools) ? tools : []) {
      if (tool?.type === "namespace" && tool.name && Array.isArray(tool.tools)) {
        for (const nested of tool.tools) {
          if ([OPENAI_BLOCK.FUNCTION, "custom"].includes(nested?.type)) add(nested.name, tool.name);
        }
      } else {
        add(tool?.function?.name || tool?.name);
      }
    }
  };
  collect(body?.tools);
  const input = Array.isArray(body?.input) ? body.input : [];
  for (const item of input) {
    if (item?.type === RESPONSES_ITEM.ADDITIONAL_TOOLS) collect(item.tools);
  }
  for (const item of input) {
    if ([RESPONSES_ITEM.FUNCTION_CALL, RESPONSES_ITEM.CUSTOM_TOOL_CALL].includes(item?.type)) {
      // Older clients omit namespace when the name is already unambiguous.
      if (item.namespace || ![...entries.values()].some(entry => entry.name === item.name)) add(item.name, item.namespace);
    }
  }
  const counts = new Map();
  for (const { name } of entries.values()) counts.set(name, (counts.get(name) || 0) + 1);
  const reserved = new Set(counts.keys());
  for (const entry of entries.values()) {
    entry.upstreamName = entry.name;
    if (!entry.namespace || counts.get(entry.name) === 1) continue;
    const base = `${entry.namespace}__${entry.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, CHAT_TOOL_NAME_MAX_LENGTH);
    let alias = base;
    for (let i = 2; reserved.has(alias); i++) {
      const suffix = `_${i}`;
      alias = base.slice(0, CHAT_TOOL_NAME_MAX_LENGTH - suffix.length) + suffix;
    }
    reserved.add(alias);
    entry.upstreamName = alias;
  }
  return {
    entries: [...entries.values()],
    resolve(name, namespace) {
      return entries.get(key(name, namespace))?.upstreamName
        || [...entries.values()].find(entry => entry.name === name)?.upstreamName
        || name;
    },
  };
}

// Recover the namespace using the name actually sent to the Chat provider.
export function collectResponsesToolNamespaces(body) {
  return new Map(collectResponsesToolNames(body).entries
    .filter(entry => entry.namespace)
    .map(entry => [entry.upstreamName, entry.namespace]));
}

/**
 * Normalize Responses API input to array format.
 * Accepts string or array, returns array of message items.
 * An empty array is treated like an empty string — providers require at least one user
 * message, so we inject a placeholder rather than forwarding an empty messages[].
 * @param {string|Array} input - raw input from Responses API body
 * @returns {Array|null} normalized array or null if invalid
 */
export function normalizeResponsesInput(input) {
  if (typeof input === "string") {
    const text = input.trim() === "" ? "..." : input;
    return [{ type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text }] }];
  }
  if (Array.isArray(input)) {
    // Empty input[] would produce messages:[] which all providers reject (#389)
    if (input.length === 0) {
      return [{ type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: "..." }] }];
    }
    return input;
  }
  return null;
}

// Strict Responses upstreams reject overlong call_ids with InputValidationError (#393).
export const MAX_RESPONSES_CALL_ID_LEN = 64;

// Fallback ids share one Date.now() when a batch of items is sanitized in a tight
// loop — a per-process sequence keeps same-millisecond ids unique so
// function_call ↔ function_call_output correlation never collides.
let responsesCallIdSeq = 0;

export function clampResponsesCallId(id) {
  if (typeof id !== "string" || !id) return `call_${Date.now()}_${(responsesCallIdSeq += 1)}`;
  return id.length > MAX_RESPONSES_CALL_ID_LEN ? id.substring(0, MAX_RESPONSES_CALL_ID_LEN) : id;
}

// Single-stringify: objects → JSON once; valid JSON strings pass through untouched;
// anything else (partial fragments, empty) falls back to "{}" instead of
// double-encoding and tripping upstream InputValidationError.
export function coerceResponsesArguments(value) {
  if (value === undefined || value === null || value === "") return "{}";
  if (typeof value !== "string") {
    try {
      return JSON.stringify(value);
    } catch {
      return "{}";
    }
  }
  try {
    JSON.parse(value);
    return value;
  } catch {
    return "{}";
  }
}

// function_call_output.output must be a string — never null/object.
export function coerceResponsesOutput(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) {
    return value.map((c) => {
      try {
        return c?.text ?? JSON.stringify(c);
      } catch {
        return String(c);
      }
    }).join("");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Convert OpenAI Responses API format to standard chat completions format
 * Responses API uses: { input: [...], instructions: "..." }
 * Chat API uses: { messages: [...] }
 */
export function convertResponsesApiFormat(body) {
  if (!body.input) return body;

  const result = { ...body };
  result.messages = [];

  // Convert instructions to system message
  if (body.instructions) {
    result.messages.push({ role: ROLE.SYSTEM, content: body.instructions });
  }

  // Group items by conversation turn
  let currentAssistantMsg = null;
  let pendingToolCalls = [];
  let pendingToolResults = [];

  const inputItems = normalizeResponsesInput(body.input);
  if (!inputItems) return body;

  for (const item of inputItems) {
    // Determine item type - Droid CLI sends role-based items without 'type' field
    // Fallback: if no type but has role property, treat as message
    const itemType = item.type || (item.role ? RESPONSES_ITEM.MESSAGE : null);

    if (itemType === RESPONSES_ITEM.MESSAGE) {
      // Flush any pending assistant message with tool calls
      if (currentAssistantMsg) {
        result.messages.push(currentAssistantMsg);
        currentAssistantMsg = null;
      }
      // Flush pending tool results
      if (pendingToolResults.length > 0) {
        for (const tr of pendingToolResults) {
          result.messages.push(tr);
        }
        pendingToolResults = [];
      }

      // Convert content: input_text → text, output_text → text, input_image → image_url
      const content = Array.isArray(item.content)
        ? item.content.map(c => {
          if (c.type === RESPONSES_ITEM.INPUT_TEXT) return { type: OPENAI_BLOCK.TEXT, text: c.text };
          if (c.type === RESPONSES_ITEM.OUTPUT_TEXT) return { type: OPENAI_BLOCK.TEXT, text: c.text };
          if (c.type === RESPONSES_ITEM.INPUT_IMAGE) {
            const url = c.image_url || c.file_id || "";
            return { type: OPENAI_BLOCK.IMAGE_URL, image_url: { url, detail: c.detail || "auto" } };
          }
          return c;
        })
        : item.content;
      result.messages.push({ role: item.role, content });
    }
    else if (itemType === RESPONSES_ITEM.FUNCTION_CALL) {
      // Start or append to assistant message with tool_calls
      if (!currentAssistantMsg) {
        currentAssistantMsg = {
          role: ROLE.ASSISTANT,
          content: null,
          tool_calls: []
        };
      }
      // Skip items with empty/missing name — upstream APIs reject nameless tool calls (#444)
      if (!item.name || typeof item.name !== "string" || item.name.trim() === "") continue;
      currentAssistantMsg.tool_calls.push({
        id: item.call_id,
        type: OPENAI_BLOCK.FUNCTION,
        function: {
          name: item.name,
          arguments: item.arguments
        }
      });
    }
    else if (itemType === RESPONSES_ITEM.FUNCTION_CALL_OUTPUT) {
      // Flush assistant message first if exists
      if (currentAssistantMsg) {
        result.messages.push(currentAssistantMsg);
        currentAssistantMsg = null;
      }
      // Add tool result
      pendingToolResults.push({
        role: ROLE.TOOL,
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output)
      });
    }
    else if (itemType === RESPONSES_ITEM.REASONING) {
      // Skip reasoning items - they are for display only
      continue;
    }
  }

  // Flush remaining
  if (currentAssistantMsg) {
    result.messages.push(currentAssistantMsg);
  }
  if (pendingToolResults.length > 0) {
    for (const tr of pendingToolResults) {
      result.messages.push(tr);
    }
  }

  // Cleanup Responses API specific fields
  delete result.input;
  delete result.instructions;
  delete result.include;
  delete result.prompt_cache_key;
  delete result.store;
  delete result.reasoning;

  return result;
}
