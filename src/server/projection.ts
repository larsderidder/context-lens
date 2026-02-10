import type { CapturedEntry } from '../types.js';

/**
 * Create a lightweight entry projection for APIs / persistence.
 *
 * `contextInfo` can be either the raw `ContextInfo` or a compacted projection.
 * This avoids duplicating the same mapping logic across store + web UI.
 */
export function projectEntry(e: CapturedEntry, contextInfo: any) {
  const resp = e.response as Record<string, any> | undefined;
  const usage = resp?.usage;
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
    usage: usage ? {
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
      cacheWriteTokens: usage.cache_creation_input_tokens || 0,
    } : null,
    responseModel: resp?.model || null,
    stopReason: resp?.stop_reason || null,
  };
}

