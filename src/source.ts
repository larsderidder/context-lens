import type { ContextInfo, SourceSignature, HeaderSignature } from './types.js';

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

