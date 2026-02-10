import { createHash } from 'node:crypto';
import type { ContextInfo, ParsedMessage } from '../types.js';

/**
 * Extract readable text from message content.
 *
 * This is used for labels/fingerprints where we want the "real" prompt text, not wrappers.
 * It understands a few common JSON wrappers used by tool APIs.
 *
 * @param content - Raw message content (string, often JSON-encoded).
 * @returns A trimmed text string or `null` if no readable text exists.
 */
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

/**
 * Extract the working directory from captured content when a tool embeds it.
 *
 * Supports:
 * - Claude Code: "Primary working directory: `/path`"
 * - Codex: "<cwd>/path</cwd>"
 * - Generic: "working directory is /path" or "cwd: /path"
 */
export function extractWorkingDirectory(contextInfo: ContextInfo): string | null {
  const allText = [
    ...(contextInfo.systemPrompts || []).map(sp => sp.content),
    ...(contextInfo.messages || []).filter(m => m.role === 'user').map(m => m.content),
  ].join('\n');

  let match = allText.match(/[Pp]rimary working directory[:\s]+[`]?([/~][^\s`\n]+)/);
  if (match) return match[1];
  match = allText.match(/<cwd>([^<]+)<\/cwd>/);
  if (match) return match[1];
  match = allText.match(/working directory(?:(?:is |= ?)|[:\s]+)[`"]?([/~][^\s`"'\n]+)/i);
  if (match) return match[1];
  match = allText.match(/\bcwd[:\s]+[`"]?([/~][^\s`"'\n]+)/);
  if (match) return match[1];

  return null;
}

/**
 * For OpenAI Responses-style input arrays, extract the first "real" user prompt.
 *
 * Skips boilerplate blocks (AGENTS.md / environment wrappers).
 */
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

/**
 * Extract a stable session identifier when the upstream/tool provides one.
 *
 * Supported:
 * - Anthropic: `metadata.user_id` contains `session_<uuid>`
 * - Gemini Code Assist: `request.session_id` (uuid)
 */
export function extractSessionId(rawBody: Record<string, any> | null | undefined): string | null {
  const userId = rawBody?.metadata?.user_id;
  if (userId) {
    const match = userId.match(/session_([a-f0-9-]+)/);
    if (match) return match[0];
  }
  const geminiSessionId = rawBody?.request?.session_id;
  if (geminiSessionId && typeof geminiSessionId === 'string') return `gemini_${geminiSessionId}`;
  return null;
}

/**
 * Compute a sub-key to distinguish agents within a session (main vs subagents).
 *
 * Currently derived from the first readable user message.
 */
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

/**
 * Compute a conversation fingerprint for grouping.
 *
 * Priority:
 * 1. explicit session IDs (most stable)
 * 2. Responses API chaining (`previous_response_id`)
 * 3. content hash of system + first prompt
 */
export function computeFingerprint(
  contextInfo: ContextInfo,
  rawBody: Record<string, any> | null | undefined,
  responseIdToConvo: Map<string, string>,
): string | null {
  const sessionId = extractSessionId(rawBody);
  if (sessionId) {
    return createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  }

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

/**
 * Extract a readable label for a conversation, primarily for UI display.
 */
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

