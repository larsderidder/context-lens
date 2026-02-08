import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { estimateTokens } from './core.js';
import type {
  CapturedEntry, ContextInfo, CompositionCategory, CompositionEntry,
  LharRecord, LharSessionLine, LharJsonWrapper, Conversation,
} from './types.js';

const COLLECTOR_NAME = 'context-lens';
const COLLECTOR_VERSION = '0.1.0';
const LHAR_VERSION = '0.1.0';

// --- Composition Analysis ---

export function analyzeComposition(
  contextInfo: ContextInfo,
  rawBody: Record<string, any> | undefined,
): CompositionEntry[] {
  const counts = new Map<CompositionCategory, { tokens: number; count: number }>();

  function add(category: CompositionCategory, tokens: number): void {
    const existing = counts.get(category);
    if (existing) {
      existing.tokens += tokens;
      existing.count += 1;
    } else {
      counts.set(category, { tokens, count: 1 });
    }
  }

  if (!rawBody) {
    // Fallback to contextInfo aggregates
    if (contextInfo.systemTokens > 0) add('system_prompt', contextInfo.systemTokens);
    if (contextInfo.toolsTokens > 0) add('tool_definitions', contextInfo.toolsTokens);
    if (contextInfo.messagesTokens > 0) add('other', contextInfo.messagesTokens);
    return buildCompositionArray(counts, contextInfo.totalTokens);
  }

  // System prompt(s)
  if (rawBody.system) {
    if (typeof rawBody.system === 'string') {
      add('system_prompt', estimateTokens(rawBody.system));
    } else if (Array.isArray(rawBody.system)) {
      for (const block of rawBody.system) {
        if (block.cache_control) {
          add('cache_markers', estimateTokens(block.cache_control));
        }
        add('system_prompt', estimateTokens(block.text || block));
      }
    }
  }

  // Instructions (OpenAI Responses API / ChatGPT)
  if (rawBody.instructions) {
    add('system_prompt', estimateTokens(rawBody.instructions));
  }

  // Tool definitions
  if (rawBody.tools && Array.isArray(rawBody.tools)) {
    add('tool_definitions', estimateTokens(JSON.stringify(rawBody.tools)));
  }

  // Messages array (Anthropic, OpenAI chat completions)
  const messages = rawBody.messages || rawBody.input;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      classifyMessage(msg, add);
    }
  } else if (typeof messages === 'string') {
    add('user_text', estimateTokens(messages));
  }

  const total = Array.from(counts.values()).reduce((s, e) => s + e.tokens, 0);
  return buildCompositionArray(counts, total);
}

function classifyMessage(
  msg: Record<string, any>,
  add: (cat: CompositionCategory, tokens: number) => void,
): void {
  const role: string = msg.role || 'user';
  const content = msg.content;

  // System / developer messages
  if (role === 'system' || role === 'developer') {
    add('system_prompt', estimateTokens(content));
    return;
  }

  // String content
  if (typeof content === 'string') {
    if (content.includes('<system-reminder>')) {
      add('system_injections', estimateTokens(content));
    } else if (role === 'assistant') {
      add('assistant_text', estimateTokens(content));
    } else {
      add('user_text', estimateTokens(content));
    }
    return;
  }

  // Array of content blocks
  if (Array.isArray(content)) {
    for (const block of content) {
      classifyBlock(block, role, add);
    }
    return;
  }

  // Fallback
  if (content) {
    add('other', estimateTokens(content));
  }
}

function classifyBlock(
  block: Record<string, any>,
  role: string,
  add: (cat: CompositionCategory, tokens: number) => void,
): void {
  const type: string = block.type || '';

  if (type === 'tool_use') {
    add('tool_calls', estimateTokens(block));
    return;
  }
  if (type === 'tool_result') {
    add('tool_results', estimateTokens(block.content || ''));
    return;
  }
  if (type === 'thinking') {
    add('thinking', estimateTokens(block.thinking || block.text || ''));
    return;
  }
  if (type === 'image' || type === 'image_url') {
    add('images', estimateTokens(block));
    return;
  }

  // Text blocks
  const text: string = block.text || '';
  if (type === 'text' || type === 'input_text' || !type) {
    if (text.includes('<system-reminder>')) {
      add('system_injections', estimateTokens(text));
    } else if (block.cache_control) {
      add('cache_markers', estimateTokens(block.cache_control));
      // Still count the text content in its natural category
      if (role === 'assistant') {
        add('assistant_text', estimateTokens(text));
      } else {
        add('user_text', estimateTokens(text));
      }
    } else if (role === 'assistant') {
      add('assistant_text', estimateTokens(text));
    } else {
      add('user_text', estimateTokens(text));
    }
    return;
  }

  add('other', estimateTokens(block));
}

function buildCompositionArray(
  counts: Map<CompositionCategory, { tokens: number; count: number }>,
  total: number,
): CompositionEntry[] {
  const result: CompositionEntry[] = [];
  for (const [category, { tokens, count }] of counts) {
    if (tokens === 0) continue;
    result.push({
      category,
      tokens,
      pct: total > 0 ? Math.round((tokens / total) * 1000) / 10 : 0,
      count,
    });
  }
  // Sort by tokens descending
  result.sort((a, b) => b.tokens - a.tokens);
  return result;
}

// --- Response Parsing ---

export interface ParsedResponseUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model: string | null;
  finishReasons: string[];
  stream: boolean;
}

export function parseResponseUsage(responseData: any): ParsedResponseUsage {
  const result: ParsedResponseUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    model: null,
    finishReasons: [],
    stream: false,
  };

  if (!responseData) return result;

  // Streaming response — scan SSE chunks for usage
  if (responseData.streaming && typeof responseData.chunks === 'string') {
    result.stream = true;
    return parseStreamingUsage(responseData.chunks, result);
  }

  // Non-streaming response
  if (responseData.usage) {
    const u = responseData.usage;
    result.inputTokens = u.input_tokens || u.prompt_tokens || 0;
    result.outputTokens = u.output_tokens || u.completion_tokens || 0;
    result.cacheReadTokens = u.cache_read_input_tokens || 0;
    result.cacheWriteTokens = u.cache_creation_input_tokens || 0;
  }

  result.model = responseData.model || null;

  if (responseData.stop_reason) {
    result.finishReasons = [responseData.stop_reason];
  } else if (responseData.choices && Array.isArray(responseData.choices)) {
    result.finishReasons = responseData.choices
      .map((c: any) => c.finish_reason)
      .filter(Boolean);
  }

  return result;
}

function parseStreamingUsage(chunks: string, result: ParsedResponseUsage): ParsedResponseUsage {
  // Parse SSE events looking for usage data
  const lines = chunks.split('\n');
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') continue;

    try {
      const parsed = JSON.parse(data);

      // Anthropic message_start: contains model
      if (parsed.type === 'message_start' && parsed.message) {
        result.model = parsed.message.model || result.model;
        if (parsed.message.usage) {
          result.inputTokens = parsed.message.usage.input_tokens || 0;
          result.cacheReadTokens = parsed.message.usage.cache_read_input_tokens || 0;
          result.cacheWriteTokens = parsed.message.usage.cache_creation_input_tokens || 0;
        }
      }

      // Anthropic message_delta: contains stop_reason and output token count
      if (parsed.type === 'message_delta') {
        if (parsed.delta?.stop_reason) {
          result.finishReasons = [parsed.delta.stop_reason];
        }
        if (parsed.usage) {
          result.outputTokens = parsed.usage.output_tokens || result.outputTokens;
        }
      }

      // OpenAI streaming: final chunk with usage
      if (parsed.usage && parsed.choices) {
        result.inputTokens = parsed.usage.prompt_tokens || result.inputTokens;
        result.outputTokens = parsed.usage.completion_tokens || result.outputTokens;
      }
      if (parsed.choices?.[0]?.finish_reason) {
        result.finishReasons = [parsed.choices[0].finish_reason];
      }
      if (parsed.model) {
        result.model = parsed.model;
      }
    } catch {
      // Skip unparseable lines
    }
  }
  return result;
}

// --- LHAR Record Builder ---

function hexId(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function traceIdFromConversation(conversationId: string | null): string {
  if (!conversationId) return hexId(16);
  // Deterministic: hash the conversationId to a 32-hex-char trace ID
  return createHash('sha256').update(conversationId).digest('hex').slice(0, 32);
}

export function buildLharRecord(
  entry: CapturedEntry,
  prevEntries: CapturedEntry[],
): LharRecord {
  const ci = entry.contextInfo;
  // Use pre-computed composition from storeRequest; fall back to recomputing
  const composition = entry.composition.length > 0
    ? entry.composition
    : analyzeComposition(ci, entry.rawBody);
  const usage = parseResponseUsage(entry.response);

  // Sequence: count entries in this conversation that came before this one (by timestamp)
  const sequence = prevEntries.filter(
    e => e.conversationId === entry.conversationId
      && e.id !== entry.id
      && new Date(e.timestamp).getTime() <= new Date(entry.timestamp).getTime()
  ).length + 1;

  // Growth tracking
  const prevInConvo = prevEntries
    .filter(e => e.conversationId === entry.conversationId && e.id !== entry.id)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const prevTokens = prevInConvo.length > 0 ? prevInConvo[0].contextInfo.totalTokens : 0;
  const tokensAdded = prevInConvo.length > 0 ? ci.totalTokens - prevTokens : null;
  const compactionDetected = tokensAdded !== null && tokensAdded < 0;

  // Agent role
  const agentRole = entry.agentKey ? 'subagent' : 'main';

  // Tokens per second
  let tokensPerSecond: number | null = null;
  if (entry.timings && entry.timings.receive_ms > 0 && usage.outputTokens > 0) {
    tokensPerSecond = Math.round((usage.outputTokens / entry.timings.receive_ms) * 1000 * 10) / 10;
  }

  const timings = entry.timings ? {
    ...entry.timings,
    tokens_per_second: tokensPerSecond,
  } : null;

  return {
    type: 'entry',
    id: randomUUID(),
    trace_id: traceIdFromConversation(entry.conversationId),
    span_id: hexId(8),
    parent_span_id: null,
    timestamp: entry.timestamp,
    sequence,

    source: {
      tool: entry.source || 'unknown',
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
        total_tokens: (usage.inputTokens || ci.totalTokens) + usage.outputTokens,
      },
    },

    usage_ext: {
      cache_read_tokens: usage.cacheReadTokens,
      cache_write_tokens: usage.cacheWriteTokens,
      cost_usd: entry.costUsd,
    },

    http: {
      method: 'POST',
      url: entry.targetUrl,
      status_code: entry.httpStatus,
      api_format: ci.apiFormat,
      stream: usage.stream,
      request_headers: entry.requestHeaders,
      response_headers: entry.responseHeaders,
    },

    timings,

    transfer: {
      request_bytes: entry.requestBytes,
      response_bytes: entry.responseBytes,
      compressed: false,
    },

    context_lens: {
      window_size: entry.contextLimit,
      utilization: entry.contextLimit > 0
        ? Math.round((ci.totalTokens / entry.contextLimit) * 1000) / 1000
        : 0,
      system_tokens: ci.systemTokens,
      tools_tokens: ci.toolsTokens,
      messages_tokens: ci.messagesTokens,
      composition,
      growth: {
        tokens_added_this_turn: tokensAdded,
        cumulative_tokens: ci.totalTokens,
        compaction_detected: compactionDetected,
      },
    },

    raw: {
      request_body: null,
      response_body: null,
    },
  };
}

// --- Session Line ---

export function buildSessionLine(
  conversationId: string,
  conversation: Conversation,
  model: string,
): LharSessionLine {
  return {
    type: 'session',
    trace_id: traceIdFromConversation(conversationId),
    started_at: conversation.firstSeen,
    tool: conversation.source,
    model,
  };
}

// --- Export Serialization ---

export function toLharJsonl(entries: CapturedEntry[], conversations: Map<string, Conversation>): string {
  // Sort oldest-first for JSONL
  const sorted = [...entries].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const lines: string[] = [];
  const emittedSessions = new Set<string>();

  for (const entry of sorted) {
    const record = buildLharRecord(entry, entries);

    // Emit session preamble on first occurrence of each trace_id
    if (!emittedSessions.has(record.trace_id)) {
      emittedSessions.add(record.trace_id);
      const convo = entry.conversationId
        ? conversations.get(entry.conversationId)
        : undefined;
      if (convo) {
        lines.push(JSON.stringify(buildSessionLine(entry.conversationId!, convo, record.gen_ai.request.model)));
      }
    }

    lines.push(JSON.stringify(record));
  }

  return lines.join('\n') + '\n';
}

export function toLharJson(
  entries: CapturedEntry[],
  conversations: Map<string, Conversation>,
): LharJsonWrapper {
  const sorted = [...entries].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const records = sorted.map(entry => buildLharRecord(entry, entries));

  // Build sessions from conversations map
  const sessions: LharJsonWrapper['lhar']['sessions'] = [];
  const seenTraces = new Set<string>();
  for (const record of records) {
    if (!seenTraces.has(record.trace_id)) {
      seenTraces.add(record.trace_id);
      const convo = record.trace_id
        ? Array.from(conversations.values()).find(
            c => traceIdFromConversation(c.id) === record.trace_id
          )
        : undefined;
      sessions.push({
        trace_id: record.trace_id,
        started_at: convo?.firstSeen || record.timestamp,
        tool: record.source.tool,
        model: record.gen_ai.request.model,
      });
    }
  }

  return {
    lhar: {
      version: LHAR_VERSION,
      creator: {
        name: COLLECTOR_NAME,
        version: COLLECTOR_VERSION,
      },
      sessions,
      entries: records,
    },
  };
}
