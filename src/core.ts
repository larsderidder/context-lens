import { createHash } from 'node:crypto';
import type {
  Provider, ApiFormat, ContextInfo, ParsedMessage, ContentBlock,
  SourceSignature, HeaderSignature, ExtractSourceResult, ParsedUrl, Upstreams,
  ResolveTargetResult,
} from './types.js';

// Model context limits (tokens) — more specific keys first
export const CONTEXT_LIMITS: Record<string, number> = {
  // Anthropic
  'claude-opus-4': 200000,
  'claude-sonnet-4': 200000,
  'claude-haiku-4': 200000,
  'claude-3-5-sonnet': 200000,
  'claude-3-5-haiku': 200000,
  'claude-3-opus': 200000,
  // OpenAI — specific before generic
  'gpt-4o-mini': 128000,
  'gpt-4o': 128000,
  'gpt-4-turbo': 128000,
  'gpt-4': 8192,
  'gpt-3.5-turbo': 16385,
  'o4-mini': 200000,
  'o3-mini': 200000,
  'o3': 200000,
  'o1-mini': 128000,
  'o1': 200000,
  // Gemini
  'gemini-2.5-pro': 1048576,
  'gemini-2.5-flash': 1048576,
  'gemini-2.0-flash': 1048576,
  'gemini-1.5-pro': 2097152,
  'gemini-1.5-flash': 1048576,
};

// Auto-detect source tool from request headers (primary)
export const HEADER_SIGNATURES: HeaderSignature[] = [
  { header: 'user-agent', pattern: /^claude-cli\//, source: 'claude' },
  { header: 'user-agent', pattern: /aider/i, source: 'aider' },
  { header: 'user-agent', pattern: /kimi/i, source: 'kimi' },
  { header: 'user-agent', pattern: /^GeminiCLI\//, source: 'gemini' },
];

// Auto-detect source tool from system prompt (fallback)
export const SOURCE_SIGNATURES: SourceSignature[] = [
  { pattern: 'Act as an expert software developer', source: 'aider' },
  { pattern: 'You are Claude Code', source: 'claude' },
  { pattern: 'You are Kimi Code CLI', source: 'kimi' },
];

// Known API path segments — not treated as source prefixes
export const API_PATH_SEGMENTS = new Set([
  'v1', 'v1beta', 'v1alpha', 'v1internal', 'responses', 'chat', 'models', 'embeddings', 'backend-api', 'api',
]);

// Simple token estimation: chars / 4
export function estimateTokens(text: unknown): number {
  if (!text) return 0;
  const s = typeof text === 'object' ? JSON.stringify(text) : String(text);
  return Math.ceil(s.length / 4);
}

// Detect provider from request
export function detectProvider(pathname: string, headers: Record<string, string | undefined>): Provider {
  if (pathname.match(/^\/(api|backend-api)\//)) return 'chatgpt';
  if (pathname.includes('/v1/messages') || pathname.includes('/v1/complete')) return 'anthropic';
  if (headers['anthropic-version']) return 'anthropic';
  // Gemini: must come BEFORE openai catch-all (which matches /models/)
  if (pathname.includes(':generateContent') || pathname.includes(':streamGenerateContent') || pathname.match(/\/v1(beta|alpha)\/models\//) || pathname.includes('/v1internal:'))
    return 'gemini';
  if (headers['x-goog-api-key']) return 'gemini';
  if (pathname.match(/\/(responses|chat\/completions|models|embeddings)/)) return 'openai';
  if (headers['authorization']?.startsWith('Bearer sk-')) return 'openai';
  return 'unknown';
}

// Detect which API format is being used
export function detectApiFormat(pathname: string): ApiFormat {
  if (pathname.includes('/v1/messages')) return 'anthropic-messages';
  if (pathname.match(/^\/(api|backend-api)\//)) return 'chatgpt-backend';
  if (pathname.includes(':generateContent') || pathname.includes(':streamGenerateContent') || pathname.match(/\/v1(beta|alpha)\/models\//) || pathname.includes('/v1internal:'))
    return 'gemini';
  if (pathname.includes('/responses')) return 'responses';
  if (pathname.includes('/chat/completions')) return 'chat-completions';
  return 'unknown';
}

// Parse a single item from the OpenAI Responses API `input` array.
// Maps typed items (function_call, function_call_output, reasoning, output_text, etc.)
// to normalized ParsedMessage with proper role and contentBlocks.
function parseResponsesItem(item: any): { message: ParsedMessage; tokens: number; isSystem: boolean; content: string } {
  const type: string = item.type || '';

  // Standard message with role/content (e.g. {"type":"message","role":"user","content":[...]})
  if (item.role) {
    const isSystem = item.role === 'system' || item.role === 'developer';
    let content: string;
    let contentBlocks: ContentBlock[] | null = null;
    if (typeof item.content === 'string') {
      content = item.content;
    } else if (Array.isArray(item.content)) {
      contentBlocks = item.content as ContentBlock[];
      content = item.content.map((b: any) => b.text || '').join('\n');
    } else {
      content = JSON.stringify(item.content || item);
    }
    const tokens = estimateTokens(item.content ?? content);
    return { message: { role: item.role, content, contentBlocks, tokens }, tokens, isSystem, content };
  }

  // function_call → assistant tool_use
  if (type === 'function_call' || type === 'custom_tool_call') {
    const name = item.name || 'unknown';
    const args = item.arguments || '';
    const content = name + '(' + (typeof args === 'string' ? args.slice(0, 200) : JSON.stringify(args).slice(0, 200)) + ')';
    const tokens = estimateTokens(item);
    const block: ContentBlock = { type: 'tool_use', id: item.call_id || '', name, input: typeof args === 'string' ? {} : (args || {}) };
    return { message: { role: 'assistant', content, contentBlocks: [block], tokens }, tokens, isSystem: false, content };
  }

  // function_call_output → user tool_result
  if (type === 'function_call_output' || type === 'custom_tool_call_output') {
    const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output || '');
    const tokens = estimateTokens(output);
    const block: ContentBlock = { type: 'tool_result', tool_use_id: item.call_id || '', content: output };
    return { message: { role: 'user', content: output, contentBlocks: [block], tokens }, tokens, isSystem: false, content: output };
  }

  // reasoning → assistant thinking
  if (type === 'reasoning') {
    const summary = Array.isArray(item.summary)
      ? item.summary.map((s: any) => s.text || '').join('\n')
      : '';
    const content = summary || '[reasoning]';
    const tokens = estimateTokens(item);
    return { message: { role: 'assistant', content, contentBlocks: [{ type: 'thinking', thinking: content } as any], tokens }, tokens, isSystem: false, content };
  }

  // output_text → assistant text
  if (type === 'output_text') {
    const text = item.text || '';
    const tokens = estimateTokens(text);
    return { message: { role: 'assistant', content: text, contentBlocks: [{ type: 'text', text }], tokens }, tokens, isSystem: false, content: text };
  }

  // input_text → user text
  if (type === 'input_text') {
    const text = item.text || '';
    const tokens = estimateTokens(text);
    return { message: { role: 'user', content: text, contentBlocks: [{ type: 'text', text }], tokens }, tokens, isSystem: false, content: text };
  }

  // Fallback: serialize the whole item
  const content = JSON.stringify(item);
  const tokens = estimateTokens(content);
  return { message: { role: item.role || 'user', content, tokens }, tokens, isSystem: false, content };
}

// Parse request body and extract context info
export function parseContextInfo(provider: string, body: Record<string, any>, apiFormat: string): ContextInfo {
  const info: ContextInfo = {
    provider,
    apiFormat,
    model: body.model || 'unknown',
    systemTokens: 0,
    toolsTokens: 0,
    messagesTokens: 0,
    totalTokens: 0,
    systemPrompts: [],
    tools: [],
    messages: [],
  };

  if (provider === 'anthropic') {
    if (body.system) {
      const systemText = typeof body.system === 'string'
        ? body.system
        : Array.isArray(body.system)
          ? body.system.map((b: any) => b.text || '').join('\n')
          : JSON.stringify(body.system);
      info.systemPrompts.push({ content: systemText });
      info.systemTokens = estimateTokens(systemText);
    }

    if (body.tools && Array.isArray(body.tools)) {
      info.tools = body.tools;
      info.toolsTokens = estimateTokens(JSON.stringify(body.tools));
    }

    if (body.messages && Array.isArray(body.messages)) {
      info.messages = body.messages.map((msg: any): ParsedMessage => {
        const contentBlocks = Array.isArray(msg.content) ? msg.content : null;
        return {
          role: msg.role,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          contentBlocks,
          tokens: estimateTokens(msg.content),
        };
      });
      info.messagesTokens = info.messages.reduce((sum, m) => sum + m.tokens, 0);
    }
  } else if (apiFormat === 'responses' || provider === 'chatgpt') {
    // System prompts
    if (body.instructions) {
      info.systemPrompts.push({ content: body.instructions });
      info.systemTokens = estimateTokens(body.instructions);
    }
    if (body.system) {
      const systemText = typeof body.system === 'string'
        ? body.system
        : Array.isArray(body.system)
          ? body.system.map((b: any) => b.text || '').join('\n')
          : JSON.stringify(body.system);
      info.systemPrompts.push({ content: systemText });
      info.systemTokens += estimateTokens(systemText);
    }

    // Parse input/messages — handle Responses API typed items
    const msgs = body.input || body.messages;
    if (msgs) {
      if (typeof msgs === 'string') {
        info.messages.push({ role: 'user', content: msgs, tokens: estimateTokens(msgs) });
        info.messagesTokens = estimateTokens(msgs);
      } else if (Array.isArray(msgs)) {
        msgs.forEach((item: any) => {
          const parsed = parseResponsesItem(item);
          if (parsed.isSystem) {
            info.systemPrompts.push({ content: parsed.content });
            info.systemTokens += parsed.tokens;
          } else {
            info.messages.push(parsed.message);
            info.messagesTokens += parsed.tokens;
          }
        });
      }
    }

    if (body.tools && Array.isArray(body.tools)) {
      info.tools = body.tools;
      info.toolsTokens = estimateTokens(JSON.stringify(body.tools));
    }
  } else if (provider === 'gemini' || apiFormat === 'gemini') {
    // Gemini API: contents[], systemInstruction, tools[{functionDeclarations}]
    // Code Assist wraps everything inside body.request: {contents, systemInstruction, tools, ...}
    const geminiBody = body.request || body;
    if (geminiBody.systemInstruction) {
      const parts = geminiBody.systemInstruction.parts || [];
      const systemText = parts.map((p: any) => p.text || '').join('\n');
      info.systemPrompts.push({ content: systemText });
      info.systemTokens = estimateTokens(systemText);
    }
    if (geminiBody.tools && Array.isArray(geminiBody.tools)) {
      const allDecls = geminiBody.tools.flatMap((t: any) => t.functionDeclarations || []);
      info.tools = allDecls;
      info.toolsTokens = estimateTokens(JSON.stringify(geminiBody.tools));
    }
    if (geminiBody.contents && Array.isArray(geminiBody.contents)) {
      info.messages = geminiBody.contents.map((turn: any): ParsedMessage => {
        const role = turn.role || 'user';
        const parts = turn.parts || [];
        const contentBlocks: ContentBlock[] = [];
        const textParts: string[] = [];
        for (const part of parts) {
          if (part.text) {
            textParts.push(part.text);
            contentBlocks.push({ type: 'text', text: part.text });
          } else if (part.functionCall) {
            contentBlocks.push({
              type: 'tool_use', id: part.functionCall.id || '', name: part.functionCall.name || '',
              input: part.functionCall.args || {},
            });
          } else if (part.functionResponse) {
            const resp = part.functionResponse.response;
            // Gemini CLI wraps tool output in {output: "..."} or {error: "..."}
            const respText = typeof resp === 'string' ? resp
              : typeof resp?.output === 'string' ? resp.output
              : typeof resp?.error === 'string' ? resp.error
              : JSON.stringify(resp || '');
            contentBlocks.push({
              type: 'tool_result', tool_use_id: part.functionResponse.id || '',
              content: respText,
            });
          } else if (part.inlineData) {
            contentBlocks.push({ type: 'image' });
          } else if (part.executableCode) {
            contentBlocks.push({ type: 'text', text: part.executableCode.code || '' });
          } else if (part.codeExecutionResult) {
            contentBlocks.push({ type: 'text', text: part.codeExecutionResult.output || '' });
          }
        }
        const content = textParts.join('\n') || JSON.stringify(parts);
        const tokens = estimateTokens(turn);
        return { role: role === 'model' ? 'assistant' : role, content, contentBlocks, tokens };
      });
      info.messagesTokens = info.messages.reduce((sum, m) => sum + m.tokens, 0);
    }
  } else if (provider === 'openai') {
    if (body.messages && Array.isArray(body.messages)) {
      body.messages.forEach((msg: any) => {
        if (msg.role === 'system' || msg.role === 'developer') {
          info.systemPrompts.push({ content: msg.content });
          info.systemTokens += estimateTokens(msg.content);
        } else {
          info.messages.push({
            role: msg.role,
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            tokens: estimateTokens(msg.content),
          });
          info.messagesTokens += estimateTokens(msg.content);
        }
      });
    }

    if (body.tools && Array.isArray(body.tools)) {
      info.tools = body.tools;
      info.toolsTokens = estimateTokens(JSON.stringify(body.tools));
    } else if (body.functions && Array.isArray(body.functions)) {
      info.tools = body.functions;
      info.toolsTokens = estimateTokens(JSON.stringify(body.functions));
    }
  }

  info.totalTokens = info.systemTokens + info.toolsTokens + info.messagesTokens;
  return info;
}

// Get context limit for model
export function getContextLimit(model: string): number {
  for (const [key, limit] of Object.entries(CONTEXT_LIMITS)) {
    if (model.includes(key)) return limit;
  }
  return 128000; // default fallback
}

// Model pricing: [inputPerMTok, outputPerMTok] in USD
// Keys ordered most-specific-first to avoid substring false matches (e.g. gpt-4o-mini before gpt-4o)
export const MODEL_PRICING: Record<string, [number, number]> = {
  'claude-opus-4':   [15, 75],
  'claude-sonnet-4': [3, 15],
  'claude-haiku-4':  [0.80, 4],
  'claude-3-5-sonnet': [3, 15],
  'claude-3-5-haiku':  [0.80, 4],
  'claude-3-opus':   [15, 75],
  'gpt-4o-mini':     [0.15, 0.60],
  'gpt-4o':          [2.50, 10],
  'gpt-4-turbo':     [10, 30],
  'gpt-4':           [30, 60],
  'o4-mini':         [1.10, 4.40],
  'o3-mini':         [1.10, 4.40],
  'o3':              [10, 40],
  'o1-mini':         [3, 12],
  'o1':              [15, 60],
  // Codex (subscription estimate)
  'gpt-5.3-codex':       [1.75, 14],
  'gpt-5.2-codex':       [1.75, 14],
  'gpt-5.1-codex-mini':  [0.25, 2],
  'gpt-5.1-codex':       [1.25, 10],
  'gpt-5-codex':         [1.25, 10],
  // Gemini
  'gemini-2.5-pro':  [1.25, 10],
  'gemini-2.5-flash': [0.15, 0.60],
  'gemini-2.0-flash': [0.10, 0.40],
  'gemini-1.5-pro':  [1.25, 5],
  'gemini-1.5-flash': [0.075, 0.30],
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number | null {
  for (const [key, [inp, out]] of Object.entries(MODEL_PRICING)) {
    if (model.includes(key)) {
      return Math.round((inputTokens * inp + outputTokens * out) / 1_000_000 * 1_000_000) / 1_000_000;
    }
  }
  return null;
}

// Extract source tag from URL path
export function extractSource(pathname: string): ExtractSourceResult {
  const match = pathname.match(/^\/([^/]+)(\/.*)?$/);
  if (match && match[2] && !API_PATH_SEGMENTS.has(match[1])) {
    // `decodeURIComponent` may introduce `/` via `%2f` (path traversal) or throw on bad encodings.
    // Treat suspicious/invalid tags as "no source tag" and route the request normally.
    let decoded = match[1];
    try {
      decoded = decodeURIComponent(match[1]);
    } catch {
      decoded = match[1];
    }
    if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('..')) {
      return { source: null, cleanPath: pathname };
    }
    return { source: decoded, cleanPath: match[2] || '/' };
  }
  return { source: null, cleanPath: pathname };
}

// Determine target URL for a request
export function resolveTargetUrl(parsedUrl: ParsedUrl, headers: Record<string, string | undefined>, upstreams: Upstreams): ResolveTargetResult {
  const provider = detectProvider(parsedUrl.pathname, headers);
  const search = parsedUrl.search || '';
  let targetUrl = headers['x-target-url'];
  if (!targetUrl) {
    if (provider === 'chatgpt') {
      targetUrl = upstreams.chatgpt + parsedUrl.pathname + search;
    } else if (provider === 'anthropic') {
      targetUrl = upstreams.anthropic + parsedUrl.pathname + search;
    } else if (provider === 'gemini') {
      const isCodeAssist = parsedUrl.pathname.includes('/v1internal');
      targetUrl = (isCodeAssist ? upstreams.geminiCodeAssist : upstreams.gemini) + parsedUrl.pathname + search;
    } else {
      targetUrl = upstreams.openai + parsedUrl.pathname + search;
    }
  } else if (!targetUrl.startsWith('http')) {
    targetUrl = targetUrl + parsedUrl.pathname + search;
  }
  return { targetUrl, provider };
}

// Extract readable text from message content, stripping JSON wrappers and system-reminder blocks
export function extractReadableText(content: string | null | undefined): string | null {
  if (!content) return null;
  let text = content;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      const textBlock = parsed.find((b: any) =>
        (b.type === 'text' && b.text && !b.text.startsWith('<system-reminder>'))
        || (b.type === 'input_text' && b.text && !b.text.startsWith('#') && !b.text.startsWith('<environment'))
      );
      if (textBlock) text = textBlock.text;
    }
  } catch {}
  text = text.replace(/\s+/g, ' ').trim();
  return text || null;
}

// Extract working directory from system prompt or messages
export function extractWorkingDirectory(contextInfo: ContextInfo): string | null {
  const allText = [
    ...(contextInfo.systemPrompts || []).map(sp => sp.content),
    ...(contextInfo.messages || []).filter(m => m.role === 'user').map(m => m.content),
  ].join('\n');

  // Claude Code: "Primary working directory: /path/to/dir"
  let match = allText.match(/[Pp]rimary working directory[:\s]+[`]?([/~][^\s`\n]+)/);
  if (match) return match[1];
  // Codex: "<cwd>/path/to/dir</cwd>"
  match = allText.match(/<cwd>([^<]+)<\/cwd>/);
  if (match) return match[1];
  // Generic: "working directory is /path" or "cwd: /path"
  match = allText.match(/working directory (?:is |= ?)[`"]?([/~][^\s`"'\n]+)/i);
  if (match) return match[1];
  match = allText.match(/\bcwd[:\s]+[`"]?([/~][^\s`"'\n]+)/);
  if (match) return match[1];

  return null;
}

// Extract the actual user prompt from a Responses API input array
export function extractUserPrompt(messages: ParsedMessage[]): string | null {
  for (const m of messages) {
    if (m.role !== 'user' || !m.content) continue;
    try {
      const parsed = JSON.parse(m.content);
      if (Array.isArray(parsed) && parsed[0] && parsed[0].type === 'input_text') {
        const text = parsed[0].text || '';
        if (text.startsWith('#') || text.startsWith('<environment')) continue;
        return m.content;
      }
    } catch {}
  }
  return null;
}

// Extract session ID from request body (Anthropic metadata.user_id or Gemini Code Assist session_id)
export function extractSessionId(rawBody: Record<string, any> | null | undefined): string | null {
  // Anthropic: metadata.user_id contains "session_<uuid>"
  const userId = rawBody?.metadata?.user_id;
  if (userId) {
    const match = userId.match(/session_([a-f0-9-]+)/);
    if (match) return match[0];
  }
  // Gemini Code Assist: request.session_id is a UUID
  const geminiSessionId = rawBody?.request?.session_id;
  if (geminiSessionId && typeof geminiSessionId === 'string') return `gemini_${geminiSessionId}`;
  return null;
}

// Compute a sub-key to distinguish agents within a session
export function computeAgentKey(contextInfo: ContextInfo): string | null {
  const userMsgs = (contextInfo.messages || []).filter(m => m.role === 'user');
  let realText = '';
  for (const msg of userMsgs) {
    const t = extractReadableText(msg.content);
    if (t) { realText = t; break; }
  }
  if (!realText) return null;
  return createHash('sha256').update(realText).digest('hex').slice(0, 12);
}

// Compute fingerprint for conversation grouping
export function computeFingerprint(
  contextInfo: ContextInfo,
  rawBody: Record<string, any> | null | undefined,
  responseIdToConvo: Map<string, string>,
): string | null {
  // Anthropic session ID = one group per CLI session
  const sessionId = extractSessionId(rawBody);
  if (sessionId) {
    return createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  }

  // Responses API chaining: if previous_response_id exists, reuse that conversation
  if (rawBody && rawBody.previous_response_id && responseIdToConvo) {
    const existing = responseIdToConvo.get(rawBody.previous_response_id);
    if (existing) return existing;
  }

  const userMsgs = (contextInfo.messages || []).filter(m => m.role === 'user');

  let promptText: string;
  if (contextInfo.apiFormat === 'responses' && userMsgs.length > 1) {
    promptText = extractUserPrompt(userMsgs) || '';
  } else {
    const firstUser = userMsgs[0];
    promptText = firstUser ? firstUser.content : '';
  }

  const systemText = (contextInfo.systemPrompts || []).map(sp => sp.content).join('\n');
  if (!systemText && !promptText) return null;
  return createHash('sha256').update(systemText + '\0' + promptText).digest('hex').slice(0, 16);
}

// Extract a readable label for a conversation
export function extractConversationLabel(contextInfo: ContextInfo): string {
  const userMsgs = (contextInfo.messages || []).filter(m => m.role === 'user');

  if (contextInfo.apiFormat === 'responses' && userMsgs.length > 1) {
    const prompt = extractUserPrompt(userMsgs);
    const text = extractReadableText(prompt);
    if (text) return text.length > 80 ? text.slice(0, 77) + '...' : text;
  }

  for (let i = userMsgs.length - 1; i >= 0; i--) {
    const text = extractReadableText(userMsgs[i].content);
    if (text) return text.length > 80 ? text.slice(0, 77) + '...' : text;
  }
  return 'Unnamed conversation';
}

// Auto-detect source tool from headers (primary) and system prompt (fallback)
export function detectSource(contextInfo: ContextInfo, source: string | null, headers?: Record<string, string>): string {
  if (source && source !== 'unknown') return source;

  // Primary: check request headers
  if (headers) {
    for (const sig of HEADER_SIGNATURES) {
      const val = headers[sig.header];
      if (!val) continue;
      if (sig.pattern instanceof RegExp ? sig.pattern.test(val) : val.includes(sig.pattern)) {
        return sig.source;
      }
    }
  }

  // Fallback: check system prompt content
  const systemText = (contextInfo.systemPrompts || []).map(sp => sp.content).join('\n');
  for (const sig of SOURCE_SIGNATURES) {
    if (systemText.includes(sig.pattern)) return sig.source;
  }
  return source || 'unknown';
}
