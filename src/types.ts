// --- Core domain types ---

export type Provider = 'anthropic' | 'openai' | 'chatgpt' | 'unknown';

export type ApiFormat =
  | 'anthropic-messages'
  | 'chatgpt-backend'
  | 'responses'
  | 'chat-completions'
  | 'raw'
  | 'unknown';

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
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ContentBlock[];
}

export interface ImageBlock {
  type: 'image';
  source?: unknown;
}

export interface InputTextBlock {
  type: 'input_text';
  text: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock | InputTextBlock;

// Tool definitions (union of Anthropic and OpenAI formats)
export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface OpenAITool {
  type: 'function';
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
}

export type ResponseData =
  | { streaming: true; chunks: string }
  | { raw: true | string }
  | Record<string, unknown>;

// --- LHAR types ---

export type CompositionCategory =
  | 'system_prompt' | 'tool_definitions' | 'tool_results' | 'tool_calls'
  | 'assistant_text' | 'user_text' | 'thinking' | 'system_injections'
  | 'images' | 'cache_markers' | 'other';

export interface CompositionEntry {
  category: CompositionCategory;
  tokens: number;
  pct: number;
  count: number;
}

export interface Timings {
  send_ms: number;
  wait_ms: number;
  receive_ms: number;
  total_ms: number;
  tokens_per_second: number | null;
}

export interface RequestMeta {
  httpStatus?: number;
  timings?: Timings;
  requestBytes?: number;
  responseBytes?: number;
  targetUrl?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

export interface LharSessionLine {
  type: 'session';
  trace_id: string;
  started_at: string;
  tool: string;
  model: string;
}

export interface LharRecord {
  type: 'entry';
  id: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  timestamp: string;
  sequence: number;

  source: {
    tool: string;
    tool_version: string | null;
    agent_role: string;
    collector: string;
    collector_version: string;
  };

  gen_ai: {
    system: string;
    request: {
      model: string;
      max_tokens: number | null;
      temperature: number | null;
      top_p: number | null;
      stop_sequences: string[];
    };
    response: {
      model: string | null;
      finish_reasons: string[];
    };
    usage: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
    };
  };

  usage_ext: {
    cache_read_tokens: number;
    cache_write_tokens: number;
    cost_usd: number | null;
  };

  http: {
    method: string;
    url: string | null;
    status_code: number | null;
    api_format: string;
    stream: boolean;
    request_headers: Record<string, string>;
    response_headers: Record<string, string>;
  };

  timings: Timings | null;

  transfer: {
    request_bytes: number;
    response_bytes: number;
    compressed: boolean;
  };

  context_lens: {
    window_size: number;
    utilization: number;
    system_tokens: number;
    tools_tokens: number;
    messages_tokens: number;
    composition: CompositionEntry[];
    growth: {
      tokens_added_this_turn: number | null;
      cumulative_tokens: number;
      compaction_detected: boolean;
    };
  };

  raw: {
    request_body: null;
    response_body: null;
  };
}

export interface LharJsonWrapper {
  lhar: {
    version: string;
    creator: {
      name: string;
      version: string;
    };
    sessions: Array<{
      trace_id: string;
      started_at: string;
      tool: string;
      model: string;
    }>;
    entries: LharRecord[];
  };
}

// --- CLI types ---

export interface ToolConfig {
  childEnv: Record<string, string>;
  extraArgs: string[];
  serverEnv: Record<string, string>;
  needsMitm: boolean;
}
