import { createHash, randomBytes, randomUUID } from "node:crypto";
import { redactHeaders } from "../http/headers.js";
import type { LharRecord, LharSessionLine } from "../lhar-types.generated.js";
import type { CapturedEntry, Conversation, PrivacyLevel } from "../types.js";
import { VERSION } from "../version.generated.js";
import { analyzeComposition } from "./composition.js";
import { parseResponseUsage } from "./response.js";
import { extractToolCalls, extractToolDefinitions } from "./tools.js";

const COLLECTOR_NAME = "context-lens";
const COLLECTOR_VERSION = VERSION;

function hexId(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export function traceIdFromConversation(conversationId: string | null): string {
  if (!conversationId) return hexId(16);
  // Deterministic: hash the conversationId to a 32-hex-char trace ID
  return createHash("sha256").update(conversationId).digest("hex").slice(0, 32);
}

/**
 * Extract the response body for raw capture. Returns null if the response
 * data doesn't contain a capturable body.
 */
function responseBodyForCapture(
  response: CapturedEntry["response"],
): Record<string, unknown> | string | null {
  if (!response) return null;
  const resp = response as Record<string, any>;
  // Streaming: raw SSE chunks
  if (resp.streaming && typeof resp.chunks === "string") {
    return resp.chunks;
  }
  // Raw string response
  if (resp.raw && typeof resp.raw === "string") {
    return resp.raw;
  }
  // Marker-only raw response (body wasn't captured)
  if (resp.raw === true) {
    return null;
  }
  // Parsed JSON response object
  return resp;
}

export function buildLharRecord(
  entry: CapturedEntry,
  prevEntries: CapturedEntry[],
  privacy: PrivacyLevel = "standard",
): LharRecord {
  const ci = entry.contextInfo;
  // Use pre-computed composition from storeRequest; fall back to recomputing
  const composition =
    entry.composition.length > 0
      ? entry.composition
      : analyzeComposition(ci, entry.rawBody);
  const usage = parseResponseUsage(entry.response);

  // Sequence + growth must be derived from a stable ordering.
  // Use oldest-first timestamp ordering within the conversation; tie-break by id.
  let convoEntries = entry.conversationId
    ? prevEntries.filter((e) => e.conversationId === entry.conversationId)
    : [entry];

  // Make buildLharRecord work even if the caller doesn't include `entry` in `prevEntries`.
  if (entry.conversationId) {
    const found = convoEntries.some(
      (e) => e.id === entry.id && e.timestamp === entry.timestamp,
    );
    if (!found) convoEntries = [...convoEntries, entry];
  }

  convoEntries.sort((a, b) => {
    const dt =
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    if (dt !== 0) return dt;
    return a.id - b.id;
  });

  let convoIndex = convoEntries.findIndex(
    (e) => e.id === entry.id && e.timestamp === entry.timestamp,
  );
  if (convoIndex < 0)
    convoIndex = convoEntries.findIndex((e) => e.id === entry.id);
  if (convoIndex < 0) convoIndex = 0;
  const sequence = convoIndex + 1;

  // Agent role: the most common agentKey in the conversation is the "main" agent.
  // Entries with a different key (or null when main is non-null) are subagents.
  let agentRole: "main" | "subagent" = "main";
  let mainKey: string | null = null;
  if (entry.conversationId && convoEntries.length > 1) {
    const keyCounts = new Map<string | null, number>();
    for (const e of convoEntries) {
      keyCounts.set(e.agentKey, (keyCounts.get(e.agentKey) || 0) + 1);
    }
    let maxCount = 0;
    for (const [key, count] of keyCounts) {
      if (count > maxCount) {
        maxCount = count;
        mainKey = key;
      }
    }
    if (entry.agentKey !== mainKey) {
      agentRole = "subagent";
    }
  }

  // Growth tracking: compare to the previous same-role entry in the conversation
  // to avoid false compaction/growth spikes from main↔subagent transitions.
  let prevEntry: CapturedEntry | null = null;
  for (let i = convoIndex - 1; i >= 0; i--) {
    if (convoEntries[i].agentKey === entry.agentKey) {
      prevEntry = convoEntries[i];
      break;
    }
  }
  const prevTokens = prevEntry ? prevEntry.contextInfo.totalTokens : 0;
  const tokensAdded = prevEntry ? ci.totalTokens - prevTokens : null;
  const compactionDetected = tokensAdded !== null && tokensAdded < 0;

  // Tokens per second
  let tokensPerSecond: number | null = null;
  if (entry.timings && entry.timings.receive_ms > 0 && usage.outputTokens > 0) {
    tokensPerSecond =
      Math.round((usage.outputTokens / entry.timings.receive_ms) * 1000 * 10) /
      10;
  }

  const timings = entry.timings
    ? {
        ...entry.timings,
        tokens_per_second: tokensPerSecond,
      }
    : null;

  return {
    type: "entry",
    id: randomUUID(),
    trace_id: traceIdFromConversation(entry.conversationId),
    span_id: hexId(8),
    parent_span_id: null,
    timestamp: entry.timestamp,
    sequence,

    source: {
      tool: entry.source || "unknown",
      tool_version: null,
      agent_role: agentRole,
      collector: COLLECTOR_NAME,
      collector_version: COLLECTOR_VERSION,
    },

    gen_ai: {
      system: ci.provider,
      request: {
        model: ci.model,
        max_tokens: entry.rawBody?.max_tokens ?? null,
        temperature: entry.rawBody?.temperature ?? null,
        top_p: entry.rawBody?.top_p ?? null,
        stop_sequences: entry.rawBody?.stop_sequences || [],
      },
      response: {
        model: usage.model,
        finish_reasons: usage.finishReasons,
      },
      usage: {
        input_tokens: usage.inputTokens || ci.totalTokens,
        output_tokens: usage.outputTokens,
        total_tokens:
          (usage.inputTokens || ci.totalTokens) + usage.outputTokens,
      },
    },

    usage_ext: {
      cache_read_tokens: usage.cacheReadTokens,
      cache_write_tokens: usage.cacheWriteTokens,
      cost_usd: entry.costUsd,
    },

    http: {
      method: "POST",
      url: entry.targetUrl,
      status_code: entry.httpStatus,
      api_format: ci.apiFormat,
      stream: usage.stream,
      request_headers:
        privacy === "minimal" ? {} : redactHeaders(entry.requestHeaders),
      response_headers:
        privacy === "minimal" ? {} : redactHeaders(entry.responseHeaders),
    },

    timings,

    transfer: {
      request_bytes: entry.requestBytes,
      response_bytes: entry.responseBytes,
      compressed: false,
    },

    context_lens: {
      window_size: entry.contextLimit,
      utilization:
        entry.contextLimit > 0
          ? Math.round((ci.totalTokens / entry.contextLimit) * 1000) / 1000
          : 0,
      system_tokens: ci.systemTokens,
      tools_tokens: ci.toolsTokens,
      messages_tokens: ci.messagesTokens,
      composition,
      tool_definitions: extractToolDefinitions(ci),
      tool_calls: extractToolCalls(ci),
      growth: {
        tokens_added_this_turn: tokensAdded,
        cumulative_tokens: ci.totalTokens,
        compaction_detected: compactionDetected,
      },
      security: {
        alerts: (entry.securityAlerts || []).map((a) => ({
          message_index: a.messageIndex,
          role: a.role,
          tool_name: a.toolName,
          severity: a.severity,
          pattern: a.pattern,
          match: a.match,
          offset: a.offset,
          length: a.length,
        })),
        summary: {
          high: (entry.securityAlerts || []).filter(
            (a) => a.severity === "high",
          ).length,
          medium: (entry.securityAlerts || []).filter(
            (a) => a.severity === "medium",
          ).length,
          info: (entry.securityAlerts || []).filter(
            (a) => a.severity === "info",
          ).length,
        },
      },
    },

    raw: {
      request_body: privacy === "full" && entry.rawBody ? entry.rawBody : null,
      response_body:
        privacy === "full" ? responseBodyForCapture(entry.response) : null,
    },
  };
}

export function buildSessionLine(
  conversationId: string,
  conversation: Conversation,
  model: string,
): LharSessionLine {
  return {
    type: "session",
    trace_id: traceIdFromConversation(conversationId),
    started_at: conversation.firstSeen,
    tool: conversation.source,
    model,
  };
}
