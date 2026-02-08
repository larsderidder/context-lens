const crypto = require('crypto');

// Model context limits (tokens) — more specific keys first
const CONTEXT_LIMITS = {
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
};

// Auto-detect source tool from system prompt when not explicitly tagged
const SOURCE_SIGNATURES = [
  { pattern: 'Act as an expert software developer', source: 'aider' },
  { pattern: 'You are Claude Code', source: 'claude' },
  { pattern: 'You are Kimi Code CLI', source: 'kimi' },
];

// Known API path segments — not treated as source prefixes
const API_PATH_SEGMENTS = new Set(['v1', 'responses', 'chat', 'models', 'embeddings', 'backend-api', 'api']);

// Simple token estimation: chars / 4
function estimateTokens(text) {
  if (!text) return 0;
  if (typeof text === 'object') text = JSON.stringify(text);
  return Math.ceil(text.length / 4);
}

// Detect provider from request
function detectProvider(pathname, headers) {
  if (pathname.match(/^\/(api|backend-api)\//)) return 'chatgpt';
  if (pathname.includes('/v1/messages') || pathname.includes('/v1/complete')) return 'anthropic';
  if (headers['anthropic-version']) return 'anthropic';
  if (pathname.match(/\/(responses|chat\/completions|models|embeddings)/)) return 'openai';
  if (headers['authorization']?.startsWith('Bearer sk-')) return 'openai';
  return 'unknown';
}

// Detect which API format is being used
function detectApiFormat(pathname) {
  if (pathname.includes('/v1/messages')) return 'anthropic-messages';
  if (pathname.match(/^\/(api|backend-api)\//)) return 'chatgpt-backend';
  if (pathname.includes('/responses')) return 'responses';
  if (pathname.includes('/chat/completions')) return 'chat-completions';
  return 'unknown';
}

// Parse request body and extract context info
function parseContextInfo(provider, body, apiFormat) {
  const info = {
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
      const systemText = typeof body.system === 'string' ? body.system : JSON.stringify(body.system);
      info.systemPrompts.push({ content: systemText });
      info.systemTokens = estimateTokens(systemText);
    }

    if (body.tools && Array.isArray(body.tools)) {
      info.tools = body.tools;
      info.toolsTokens = estimateTokens(JSON.stringify(body.tools));
    }

    if (body.messages && Array.isArray(body.messages)) {
      info.messages = body.messages.map(msg => {
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
  } else if (apiFormat === 'responses') {
    if (body.instructions) {
      info.systemPrompts.push({ content: body.instructions });
      info.systemTokens = estimateTokens(body.instructions);
    }

    if (body.input) {
      if (typeof body.input === 'string') {
        info.messages.push({ role: 'user', content: body.input, tokens: estimateTokens(body.input) });
        info.messagesTokens = estimateTokens(body.input);
      } else if (Array.isArray(body.input)) {
        body.input.forEach(item => {
          const content = typeof item.content === 'string' ? item.content : JSON.stringify(item.content || item);
          if (item.role === 'system') {
            info.systemPrompts.push({ content });
            info.systemTokens += estimateTokens(content);
          } else {
            info.messages.push({ role: item.role || 'user', content, tokens: estimateTokens(content) });
            info.messagesTokens += estimateTokens(content);
          }
        });
      }
    }

    if (body.tools && Array.isArray(body.tools)) {
      info.tools = body.tools;
      info.toolsTokens = estimateTokens(JSON.stringify(body.tools));
    }
  } else if (provider === 'chatgpt') {
    if (body.instructions) {
      info.systemPrompts.push({ content: body.instructions });
      info.systemTokens = estimateTokens(body.instructions);
    }
    if (body.system) {
      const systemText = typeof body.system === 'string' ? body.system : JSON.stringify(body.system);
      info.systemPrompts.push({ content: systemText });
      info.systemTokens += estimateTokens(systemText);
    }
    const msgs = body.input || body.messages;
    if (msgs) {
      if (typeof msgs === 'string') {
        info.messages.push({ role: 'user', content: msgs, tokens: estimateTokens(msgs) });
        info.messagesTokens = estimateTokens(msgs);
      } else if (Array.isArray(msgs)) {
        msgs.forEach(item => {
          const content = typeof item.content === 'string' ? item.content : JSON.stringify(item.content || item);
          const role = item.role || 'user';
          if (role === 'system' || role === 'developer') {
            info.systemPrompts.push({ content });
            info.systemTokens += estimateTokens(content);
          } else {
            info.messages.push({ role, content, tokens: estimateTokens(content) });
            info.messagesTokens += estimateTokens(content);
          }
        });
      }
    }
    if (body.tools && Array.isArray(body.tools)) {
      info.tools = body.tools;
      info.toolsTokens = estimateTokens(JSON.stringify(body.tools));
    }
  } else if (provider === 'openai') {
    if (body.messages && Array.isArray(body.messages)) {
      body.messages.forEach(msg => {
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
function getContextLimit(model) {
  for (const [key, limit] of Object.entries(CONTEXT_LIMITS)) {
    if (model.includes(key)) return limit;
  }
  return 128000; // default fallback
}

// Extract source tag from URL path
function extractSource(pathname) {
  const match = pathname.match(/^\/([^\/]+)(\/.*)?$/);
  if (match && match[2] && !API_PATH_SEGMENTS.has(match[1])) {
    return { source: decodeURIComponent(match[1]), cleanPath: match[2] || '/' };
  }
  return { source: null, cleanPath: pathname };
}

// Determine target URL for a request
function resolveTargetUrl(parsedUrl, headers, upstreams) {
  const provider = detectProvider(parsedUrl.pathname, headers);
  const search = parsedUrl.search || '';
  let targetUrl = headers['x-target-url'];
  if (!targetUrl) {
    if (provider === 'chatgpt') {
      targetUrl = upstreams.chatgpt + parsedUrl.pathname + search;
    } else if (provider === 'anthropic') {
      targetUrl = upstreams.anthropic + parsedUrl.pathname + search;
    } else {
      targetUrl = upstreams.openai + parsedUrl.pathname + search;
    }
  } else if (!targetUrl.startsWith('http')) {
    targetUrl = targetUrl + parsedUrl.pathname + search;
  }
  return { targetUrl, provider };
}

// Extract readable text from message content, stripping JSON wrappers and system-reminder blocks
function extractReadableText(content) {
  if (!content) return null;
  let text = content;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      const textBlock = parsed.find(b =>
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
function extractWorkingDirectory(contextInfo) {
  const allText = [
    ...(contextInfo.systemPrompts || []).map(sp => sp.content),
    ...(contextInfo.messages || []).filter(m => m.role === 'user').map(m => m.content),
  ].join('\n');

  // Claude Code: "Primary working directory: /path/to/dir"
  let match = allText.match(/[Pp]rimary working directory[:\s]+[`]?([\/~][^\s`\n]+)/);
  if (match) return match[1];
  // Codex: "<cwd>/path/to/dir</cwd>"
  match = allText.match(/<cwd>([^<]+)<\/cwd>/);
  if (match) return match[1];
  // Generic: "working directory is /path" or "cwd: /path"
  match = allText.match(/working directory (?:is |= ?)[`"]?([\/~][^\s`"'\n]+)/i);
  if (match) return match[1];
  match = allText.match(/\bcwd[:\s]+[`"]?([\/~][^\s`"'\n]+)/);
  if (match) return match[1];

  return null;
}

// Extract the actual user prompt from a Responses API input array
function extractUserPrompt(messages) {
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

// Extract session ID from Anthropic metadata.user_id
function extractSessionId(rawBody) {
  const userId = rawBody?.metadata?.user_id;
  if (!userId) return null;
  const match = userId.match(/session_([a-f0-9-]+)/);
  return match ? match[0] : null;
}

// Compute a sub-key to distinguish agents within a session
function computeAgentKey(contextInfo) {
  const userMsgs = (contextInfo.messages || []).filter(m => m.role === 'user');
  let realText = '';
  for (const msg of userMsgs) {
    const t = extractReadableText(msg.content);
    if (t) { realText = t; break; }
  }
  if (!realText) return null;
  return crypto.createHash('sha256').update(realText).digest('hex').slice(0, 12);
}

// Compute fingerprint for conversation grouping
function computeFingerprint(contextInfo, rawBody, responseIdToConvo) {
  // Anthropic session ID = one group per CLI session
  const sessionId = extractSessionId(rawBody);
  if (sessionId) {
    return crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  }

  // Responses API chaining: if previous_response_id exists, reuse that conversation
  if (rawBody && rawBody.previous_response_id && responseIdToConvo) {
    const existing = responseIdToConvo.get(rawBody.previous_response_id);
    if (existing) return existing;
  }

  const userMsgs = (contextInfo.messages || []).filter(m => m.role === 'user');

  let promptText;
  if (contextInfo.apiFormat === 'responses' && userMsgs.length > 1) {
    promptText = extractUserPrompt(userMsgs) || '';
  } else {
    const firstUser = userMsgs[0];
    promptText = firstUser ? firstUser.content : '';
  }

  const systemText = (contextInfo.systemPrompts || []).map(sp => sp.content).join('\n');
  if (!systemText && !promptText) return null;
  return crypto.createHash('sha256').update(systemText + '\0' + promptText).digest('hex').slice(0, 16);
}

// Extract a readable label for a conversation
function extractConversationLabel(contextInfo) {
  const userMsgs = (contextInfo.messages || []).filter(m => m.role === 'user');

  if (contextInfo.apiFormat === 'responses' && userMsgs.length > 1) {
    const prompt = extractUserPrompt(userMsgs);
    const text = extractReadableText(prompt);
    if (text) return text.length > 80 ? text.slice(0, 77) + '...' : text;
  }

  for (const msg of userMsgs) {
    const text = extractReadableText(msg.content);
    if (text) return text.length > 80 ? text.slice(0, 77) + '...' : text;
  }
  return 'Unnamed conversation';
}

// Auto-detect source tool from system prompt
function detectSource(contextInfo, source) {
  if (source && source !== 'unknown') return source;
  const systemText = (contextInfo.systemPrompts || []).map(sp => sp.content).join('\n');
  for (const sig of SOURCE_SIGNATURES) {
    if (systemText.includes(sig.pattern)) return sig.source;
  }
  return source || 'unknown';
}

module.exports = {
  CONTEXT_LIMITS,
  SOURCE_SIGNATURES,
  API_PATH_SEGMENTS,
  estimateTokens,
  detectProvider,
  detectApiFormat,
  parseContextInfo,
  getContextLimit,
  extractSource,
  resolveTargetUrl,
  extractReadableText,
  extractWorkingDirectory,
  extractUserPrompt,
  extractSessionId,
  computeAgentKey,
  computeFingerprint,
  extractConversationLabel,
  detectSource,
};
