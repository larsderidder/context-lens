import type {
  ContextInfo,
  HeaderSignature,
  SourceSignature,
} from "../types.js";

/**
 * Header signatures used to infer which CLI/tool produced a request.
 *
 * This is best-effort: many tools do not have stable identifiers.
 */
export const HEADER_SIGNATURES: HeaderSignature[] = [
  { header: "user-agent", pattern: /^claude-cli\//, source: "claude" },
  { header: "user-agent", pattern: /aider/i, source: "aider" },
  { header: "user-agent", pattern: /kimi/i, source: "kimi" },
  { header: "user-agent", pattern: /^GeminiCLI\//, source: "gemini" },
];

/**
 * System-prompt signatures used as a fallback when headers are missing/ambiguous.
 */
export const SOURCE_SIGNATURES: SourceSignature[] = [
  { pattern: "Act as an expert software developer", source: "aider" },
  { pattern: "You are Claude Code", source: "claude" },
  { pattern: "You are Kimi Code CLI", source: "kimi" },
  { pattern: "operating inside pi, a coding agent harness", source: "pi" },
];

/**
 * Infer a human-friendly "source tool" label (claude/codex/gemini/aider/...) for attribution.
 *
 * Priority:
 * 1. explicit source tag if provided and not `"unknown"`
 * 2. request header signatures
 * 3. system prompt signatures
 * 4. fallback to `"unknown"`
 */
// Provider names used as bare source tags are not tool identifiers.
// When we see one, fall through to header/system-prompt detection.
export const PROVIDER_NAMES = new Set([
  "anthropic",
  "openai",
  "gemini",
  "chatgpt",
]);

export function detectSource(
  contextInfo: ContextInfo,
  source: string | null,
  headers?: Record<string, string>,
): string {
  if (source && source !== "unknown" && !PROVIDER_NAMES.has(source))
    return source;

  // Primary: check request headers
  if (headers) {
    for (const sig of HEADER_SIGNATURES) {
      const val = headers[sig.header];
      if (!val) continue;
      if (
        sig.pattern instanceof RegExp
          ? sig.pattern.test(val)
          : val.includes(sig.pattern)
      ) {
        return sig.source;
      }
    }
  }

  // Fallback: check system prompt content
  const systemText = (contextInfo.systemPrompts || [])
    .map((sp) => sp.content)
    .join("\n");
  for (const sig of SOURCE_SIGNATURES) {
    if (systemText.includes(sig.pattern)) return sig.source;
  }
  return source || "unknown";
}
