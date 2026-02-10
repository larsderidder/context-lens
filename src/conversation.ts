import { createHash } from 'node:crypto';
import type { ContextInfo, ParsedMessage } from './types.js';

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

