// --- Core domain types ---

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

export interface SystemPrompt {
  content: string;
}

export interface ParsedMessage {
  role: string;
  content: string;
  contentBlocks?: ContentBlock[] | null;
  tokens: number;
}

// Anthropic content block types
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

// Tool definitions (union of Anthropic and OpenAI formats)
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

// --- Source extraction ---

export interface SourceSignature {
  pattern: string;
  source: string;
}

export interface HeaderSignature {
  header: string;
  pattern: string | RegExp;
  source: string;
}

export interface ExtractSourceResult {
  source: string | null;
  cleanPath: string;
}

// --- URL resolution ---

export interface ParsedUrl {
  pathname: string;
  search?: string | null;
}

export interface Upstreams {
  openai: string;
  anthropic: string;
  chatgpt: string;
  gemini: string;
  geminiCodeAssist: string;
}

export interface ResolveTargetResult {
  targetUrl: string;
  provider: Provider;
}

// --- Server-side types ---

export interface Conversation {
  id: string;
  label: string;
  source: string;
  workingDirectory: string | null;
  firstSeen: string;
  sessionId?: string | null;
}

// --- Security scanning ---

export type AlertSeverity = "high" | "medium" | "info";

export interface SecurityAlert {
  /** Index into contextInfo.messages */
  messageIndex: number;
  role: string;
  /** Tool name if the message is a tool result/call */
  toolName: string | null;
  severity: AlertSeverity;
  /** Machine-readable pattern identifier */
  pattern: string;
  /** The matched text snippet (truncated to ~120 chars) */
  match: string;
  /** Character offset into the message content where the match starts */
  offset: number;
  /** Length of the matched region in the original content */
  length: number;
}

export interface SecuritySummary {
  high: number;
  medium: number;
  info: number;
}

export interface SecurityResult {
  alerts: SecurityAlert[];
  summary: SecuritySummary;
}

// --- Health scoring ---

export interface AuditResult {
  id: string; // e.g. 'utilization', 'tool-results'
  name: string; // e.g. 'Context Utilization'
  score: number; // 0-100
  weight: number;
  description: string; // One-sentence explanation of this score
}

export type HealthRating = "good" | "needs-work" | "poor";

export interface HealthScore {
  overall: number; // 0-100
  rating: HealthRating;
  audits: AuditResult[];
}

export interface CapturedEntry {
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
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  rawBody?: Record<string, any>;
  composition: CompositionEntry[];
  costUsd: number | null;
  healthScore: HealthScore | null;
  securityAlerts: SecurityAlert[];
}

export type ResponseData =
  | { streaming: true; chunks: string }
  | { raw: true | string }
  | Record<string, unknown>;

// --- LHAR types (generated from schema/lhar.schema.json) ---

export type {
  CompositionCategory,
  CompositionEntry,
  LharJsonWrapper,
  LharRecord,
  LharSessionLine,
  Timings,
} from "./lhar-types.generated.js";

import type { CompositionEntry, Timings } from "./lhar-types.generated.js";

export interface RequestMeta {
  httpStatus?: number;
  timings?: Timings;
  requestBytes?: number;
  responseBytes?: number;
  targetUrl?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

// --- API response types ---

export interface ProjectedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
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

// --- Privacy ---

export type PrivacyLevel = "minimal" | "standard" | "full";

// --- CLI types ---

export interface ToolConfig {
  childEnv: Record<string, string>;
  extraArgs: string[];
  serverEnv: Record<string, string>;
  needsMitm: boolean;
}
