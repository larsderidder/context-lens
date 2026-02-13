/**
 * Valibot schemas for runtime validation of persisted and ingested data.
 *
 * These schemas validate data at trust boundaries:
 * - State file (state.jsonl) loaded from disk
 * - Ingest API (POST /api/ingest) from mitmproxy addon
 * - Capture files from the proxy
 *
 * The TypeScript interfaces in types.ts remain the source of truth for
 * in-memory types. These schemas validate external data before it enters
 * the system.
 */

import * as v from "valibot";

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

const CompositionCategorySchema = v.picklist([
  "system_prompt",
  "tool_definitions",
  "tool_results",
  "tool_calls",
  "assistant_text",
  "user_text",
  "thinking",
  "system_injections",
  "images",
  "cache_markers",
  "other",
]);

const CompositionEntrySchema = v.object({
  category: CompositionCategorySchema,
  tokens: v.number(),
  pct: v.number(),
  count: v.number(),
});

// ---------------------------------------------------------------------------
// Content blocks (persisted in compacted form)
// ---------------------------------------------------------------------------

const TextBlockSchema = v.object({
  type: v.literal("text"),
  text: v.string(),
});

const ToolUseBlockSchema = v.object({
  type: v.literal("tool_use"),
  id: v.string(),
  name: v.string(),
  input: v.record(v.string(), v.unknown()),
});

// Content blocks can nest recursively (tool_result contains content blocks).
// Use a fallback schema for the nested array to avoid circular inference issues.
const NestedBlockSchema = v.looseObject({ type: v.string() });

const ToolResultBlockSchema = v.object({
  type: v.literal("tool_result"),
  tool_use_id: v.string(),
  content: v.union([v.string(), v.array(NestedBlockSchema)]),
});

const ImageBlockSchema = v.object({
  type: v.literal("image"),
});

const InputTextBlockSchema = v.object({
  type: v.literal("input_text"),
  text: v.string(),
});

// Thinking blocks are stored with a non-standard shape (type + thinking field).
// Accept any object with a type field as a fallback for forward compatibility.
const FallbackBlockSchema = v.looseObject({
  type: v.string(),
});

const ContentBlockSchema = v.union([
  TextBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ImageBlockSchema,
  InputTextBlockSchema,
  FallbackBlockSchema,
]);

// ---------------------------------------------------------------------------
// Messages and context info (as persisted in state)
// ---------------------------------------------------------------------------

const ParsedMessageSchema = v.object({
  role: v.string(),
  content: v.string(),
  contentBlocks: v.optional(v.nullable(v.array(ContentBlockSchema))),
  tokens: v.number(),
});

const SystemPromptSchema = v.object({
  content: v.string(),
});

const ContextInfoSchema = v.object({
  provider: v.string(),
  apiFormat: v.string(),
  model: v.string(),
  systemTokens: v.number(),
  toolsTokens: v.number(),
  messagesTokens: v.number(),
  totalTokens: v.number(),
  systemPrompts: v.array(SystemPromptSchema),
  tools: v.array(v.unknown()),
  messages: v.array(ParsedMessageSchema),
});

// ---------------------------------------------------------------------------
// Health scoring
// ---------------------------------------------------------------------------

const AuditResultSchema = v.object({
  id: v.string(),
  name: v.string(),
  score: v.number(),
  weight: v.number(),
  description: v.string(),
});

const HealthScoreSchema = v.object({
  overall: v.number(),
  rating: v.picklist(["good", "needs-work", "poor"]),
  audits: v.array(AuditResultSchema),
});

// ---------------------------------------------------------------------------
// Security alerts
// ---------------------------------------------------------------------------

const SecurityAlertSchema = v.object({
  messageIndex: v.number(),
  role: v.string(),
  toolName: v.nullable(v.string()),
  severity: v.picklist(["high", "medium", "info"]),
  pattern: v.string(),
  match: v.string(),
  offset: v.number(),
  length: v.number(),
});

// ---------------------------------------------------------------------------
// Timings
// ---------------------------------------------------------------------------

const TimingsSchema = v.object({
  send_ms: v.number(),
  wait_ms: v.number(),
  receive_ms: v.number(),
  total_ms: v.number(),
  tokens_per_second: v.nullable(v.number()),
});

// ---------------------------------------------------------------------------
// Usage (projected form stored in compacted response)
// ---------------------------------------------------------------------------

const ProjectedUsageSchema = v.object({
  inputTokens: v.number(),
  outputTokens: v.number(),
  cacheReadTokens: v.number(),
  cacheWriteTokens: v.number(),
});

// ---------------------------------------------------------------------------
// State file line schemas
// ---------------------------------------------------------------------------

export const ConversationLineSchema = v.object({
  type: v.literal("conversation"),
  data: v.object({
    id: v.string(),
    label: v.string(),
    source: v.string(),
    workingDirectory: v.nullable(v.string()),
    firstSeen: v.string(),
    sessionId: v.optional(v.nullable(v.string())),
  }),
});

/**
 * Schema for an entry line in state.jsonl.
 *
 * Uses looseObject for `response` because the compacted response shape
 * varies (streaming chunks, raw markers, parsed usage objects). We only
 * need the usage fields to survive; the rest is best-effort.
 */
export const EntryLineSchema = v.object({
  type: v.literal("entry"),
  data: v.object({
    id: v.number(),
    timestamp: v.string(),
    contextInfo: ContextInfoSchema,
    response: v.unknown(),
    contextLimit: v.number(),
    source: v.string(),
    conversationId: v.nullable(v.string()),
    agentKey: v.nullable(v.string()),
    agentLabel: v.string(),
    httpStatus: v.nullable(v.number()),
    timings: v.nullable(TimingsSchema),
    requestBytes: v.number(),
    responseBytes: v.number(),
    targetUrl: v.nullable(v.string()),
    composition: v.array(CompositionEntrySchema),
    costUsd: v.nullable(v.number()),
    healthScore: v.nullable(HealthScoreSchema),
    securityAlerts: v.optional(v.array(SecurityAlertSchema)),
    usage: v.optional(v.nullable(ProjectedUsageSchema)),
    responseModel: v.optional(v.nullable(v.string())),
    stopReason: v.optional(v.nullable(v.string())),
  }),
});

/**
 * A single line in state.jsonl is either a conversation or an entry.
 */
export const StateLineSchema = v.variant("type", [
  ConversationLineSchema,
  EntryLineSchema,
]);

// ---------------------------------------------------------------------------
// Ingest API (POST /api/ingest)
// ---------------------------------------------------------------------------

export const IngestPayloadSchema = v.object({
  provider: v.optional(v.string(), "unknown"),
  apiFormat: v.optional(v.string(), "unknown"),
  source: v.optional(v.string(), "unknown"),
  body: v.optional(v.record(v.string(), v.unknown()), {}),
  response: v.optional(v.record(v.string(), v.unknown()), {}),
});

// ---------------------------------------------------------------------------
// Inferred types for convenience
// ---------------------------------------------------------------------------

export type StateLineData = v.InferOutput<typeof StateLineSchema>;
export type ConversationLineData = v.InferOutput<typeof ConversationLineSchema>;
export type EntryLineData = v.InferOutput<typeof EntryLineSchema>;
export type IngestPayloadData = v.InferOutput<typeof IngestPayloadSchema>;
