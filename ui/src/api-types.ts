// Copied from src/types.ts and src/lhar-types.generated.ts
// Keep in sync manually; these types change rarely.

// --- Providers & formats ---

export type Provider =
  | "anthropic"
  | "openai"
  | "chatgpt"
  | "gemini"
  | "unknown";

export type ApiFormat =
  | "anthropic-messages"
  | "chatgpt-backend"
  | "responses"
  | "chat-completions"
  | "gemini"
  | "raw"
  | "unknown";

// --- Context parsing ---

export interface SystemPrompt {
  content: string;
}

export interface ParsedMessage {
  role: string;
  content: string;
  contentBlocks?: ContentBlock[] | null;
  tokens: number;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
}

export interface ImageBlock {
  type: "image";
  source?: unknown;
}

export interface InputTextBlock {
  type: "input_text";
  text: string;
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock
  | InputTextBlock;

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export type Tool = AnthropicTool | OpenAITool;

export interface ContextInfo {
  provider: Provider | string;
  apiFormat: ApiFormat | string;
  model: string;
  systemTokens: number;
  toolsTokens: number;
  messagesTokens: number;
  totalTokens: number;
  systemPrompts: SystemPrompt[];
  tools: Tool[];
  messages: ParsedMessage[];
}

// --- Composition (from LHAR schema) ---

export type CompositionCategory =
  | "system_prompt"
  | "tool_definitions"
  | "tool_results"
  | "tool_calls"
  | "assistant_text"
  | "user_text"
  | "thinking"
  | "system_injections"
  | "images"
  | "cache_markers"
  | "other";

export interface CompositionEntry {
  category: CompositionCategory;
  tokens: number;
  pct: number;
  count: number;
}

// --- Timings ---

export interface Timings {
  send_ms: number;
  wait_ms: number;
  receive_ms: number;
  total_ms: number;
  tokens_per_second: number | null;
}

// --- Health scoring ---

export interface AuditResult {
  id: string;
  name: string;
  score: number;
  weight: number;
  description: string;
}

export type HealthRating = "good" | "needs-work" | "poor";

export interface HealthScore {
  overall: number;
  rating: HealthRating;
  audits: AuditResult[];
}

// --- Security ---

export type AlertSeverity = "high" | "medium" | "info";

export interface SecurityAlert {
  messageIndex: number;
  role: string;
  toolName: string | null;
  severity: AlertSeverity;
  pattern: string;
  match: string;
  offset: number;
  length: number;
}

// --- Response ---

export type ResponseData =
  | { streaming: true; chunks: string }
  | { raw: true | string }
  | Record<string, unknown>;

// --- API response types ---

export interface ProjectedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
}

export interface ProjectedEntry {
  id: number;
  timestamp: string;
  contextInfo: ContextInfo;
  response: ResponseData;
  contextLimit: number;
  source: string;
  conversationId: string | null;
  agentKey: string | null;
  agentLabel: string;
  httpStatus: number | null;
  timings: Timings | null;
  requestBytes: number;
  responseBytes: number;
  targetUrl: string | null;
  composition: CompositionEntry[];
  costUsd: number | null;
  healthScore: HealthScore | null;
  securityAlerts: SecurityAlert[];
  usage: ProjectedUsage | null;
  responseModel: string | null;
  stopReason: string | null;
}

export interface Conversation {
  id: string;
  label: string;
  source: string;
  workingDirectory: string | null;
  firstSeen: string;
  sessionId?: string | null;
  tags?: string[];
}

export interface AgentGroup {
  key: string;
  label: string;
  model: string;
  entries: ProjectedEntry[];
}

export interface ConversationGroup extends Conversation {
  agents: AgentGroup[];
  entries: ProjectedEntry[];
}

// --- API response shape ---

export interface ConversationSummary extends Conversation {
  entryCount: number;
  latestTimestamp: string;
  latestModel: string;
  latestTotalTokens: number;
  contextLimit: number;
  totalCost: number;
  healthScore: HealthScore | null;
  /** Per-entry totalTokens in chronological order (oldest → newest), for sparkline rendering */
  tokenHistory: number[];
  /** User-defined tags for this session */
  tags: string[];
}

export interface ApiSummaryResponse {
  revision: number;
  conversations: ConversationSummary[];
  ungroupedCount: number;
}

export interface ApiRequestsResponse {
  revision: number;
  conversations: ConversationGroup[];
  ungrouped: ProjectedEntry[];
}

// --- Tags ---

export interface TagInfo {
  name: string;
  count: number;
}

export interface TagsResponse {
  tags: TagInfo[];
}

// --- SSE events ---

export interface SSEEvent {
  type: "connected" | "entry-added" | "conversation-deleted" | "reset" | "tags-updated";
  revision: number;
  conversationId?: string | null;
}
