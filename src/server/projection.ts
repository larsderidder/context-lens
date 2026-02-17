import { parseResponseUsage } from "../lhar.js";
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
  // Use the canonical response parser instead of ad-hoc field access
  const usage = parseResponseUsage(e.response);

  // Return null for usage if no actual data is present (all zeros)
  const hasUsageData =
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.cacheReadTokens > 0 ||
    usage.cacheWriteTokens > 0 ||
    usage.thinkingTokens > 0;

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
    usage: hasUsageData
      ? {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          thinkingTokens: usage.thinkingTokens,
        }
      : null,
    responseModel: usage.model,
    stopReason: usage.finishReasons[0] || null,
  };
}
