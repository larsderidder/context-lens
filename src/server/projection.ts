import type { CapturedEntry, ContextInfo, ProjectedEntry } from "../types.js";

/**
 * Create a lightweight entry projection for APIs / persistence.
 *
 * `contextInfo` can be either the raw `ContextInfo` or a compacted projection.
 * This avoids duplicating the same mapping logic across store + web UI.
 */
export function projectEntry(
  e: CapturedEntry,
  contextInfo: ContextInfo,
): ProjectedEntry {
  const resp = e.response as Record<string, unknown> | undefined;
  const usage = resp?.usage as Record<string, number> | undefined;
  return {
    id: e.id,
    timestamp: e.timestamp,
    contextInfo,
    response: e.response,
    contextLimit: e.contextLimit,
    source: e.source,
    conversationId: e.conversationId,
    agentKey: e.agentKey,
    agentLabel: e.agentLabel,
    httpStatus: e.httpStatus,
    timings: e.timings,
    requestBytes: e.requestBytes,
    responseBytes: e.responseBytes,
    targetUrl: e.targetUrl,
    composition: e.composition,
    costUsd: e.costUsd,
    healthScore: e.healthScore,
    securityAlerts: e.securityAlerts || [],
    usage: usage
      ? {
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
          cacheReadTokens: usage.cache_read_input_tokens || 0,
          cacheWriteTokens: usage.cache_creation_input_tokens || 0,
        }
      : null,
    responseModel: (resp?.model as string) || null,
    stopReason: (resp?.stop_reason as string) || null,
  };
}
