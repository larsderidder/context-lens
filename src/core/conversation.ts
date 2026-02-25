import { createHash } from "node:crypto";
import type { ContextInfo, ParsedMessage } from "../types.js";

/**
 * Extract readable text from message content.
 *
 * This is used for labels/fingerprints where we want the "real" prompt text, not wrappers.
 * It understands a few common JSON wrappers used by tool APIs.
 *
 * @param content - Raw message content (string, often JSON-encoded).
 * @returns A trimmed text string or `null` if no readable text exists.
 */
export function extractReadableText(
  content: string | null | undefined,
): string | null {
  if (!content) return null;
  let text = content;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      const textBlock = parsed.find(
        (b: any) =>
          (b.type === "text" &&
            b.text &&
            !b.text.startsWith("<system-reminder>")) ||
          (b.type === "input_text" &&
            b.text &&
            !b.text.startsWith("#") &&
            !b.text.startsWith("<environment")),
      );
      if (textBlock) text = textBlock.text;
    }
  } catch {
    // Expected: input may not be valid JSON; fall through to raw text
  }
  text = text.replace(/\s+/g, " ").trim();
  return text || null;
}

/**
 * Extract the working directory from captured content when a tool embeds it.
 *
 * Supports:
 * - Claude Code: "Primary working directory: `/path`"
 * - Codex: "<cwd>/path</cwd>"
 * - Gemini CLI: "I'm currently working in the directory: /path"
 * - Generic: "working directory is /path" or "cwd: /path"
 */
export function extractWorkingDirectory(
  contextInfo: ContextInfo,
  rawBody?: Record<string, any> | null,
): string | null {
  const allText = [
    ...(contextInfo.systemPrompts || []).map((sp) => sp.content),
    ...(contextInfo.messages || [])
      .filter((m) => m.role === "user")
      .map((m) => m.content),
  ].join("\n");

  let match = allText.match(
    /[Pp]rimary working directory[:\s]+[`]?([/~][^\s`\n]+)/,
  );
  if (match) return match[1];
  match = allText.match(/<cwd>([^<]+)<\/cwd>/);
  if (match) return match[1];
  // Gemini CLI: "I'm currently working in the directory: /path"
  match = allText.match(
    /working in the director(?:y|ies)[:\s]+([/~][^\s\n]+)/i,
  );
  if (match) return match[1];
  // Gemini CLI multi-dir: "working in the following directories:\n  - /path"
  match = allText.match(
    /working in the following director(?:y|ies)[^\n]*\n\s+-\s+([/~][^\s\n]+)/i,
  );
  if (match) return match[1];
  // Generic: "working directory is /path" or "working directory = /path"
  match = allText.match(/working directory (?:is |= ?)[`"]?([/~][^\s`"'\n]+)/i);
  if (match) return match[1];
  // Generic: "working directory: /path" or "working directory /path"
  match = allText.match(/working directory[:\s]+[`"]?([/~][^\s`"'\n]+)/i);
  if (match) return match[1];
  match = allText.match(/\bcwd[:\s]+[`"]?([/~][^\s`"'\n]+)/);
  if (match) return match[1];

  // Structured payload fallback (Gemini Code Assist and similar tools may
  // carry cwd in JSON fields instead of prompt text).
  const fromBody = findWorkingDirectoryInObject(rawBody ?? null);
  if (fromBody) return fromBody;

  return null;
}

/**
 * Normalize and validate string values that might represent filesystem paths.
 */
function toPathCandidate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^['"`]|['"`]$/g, "");
  if (!trimmed) return null;
  // Accept POSIX, home-relative, or Windows absolute paths.
  if (/^(\/|~\/|[A-Za-z]:[\\/])/.test(trimmed)) return trimmed;
  return null;
}

/**
 * Recursive search for cwd-like fields in structured request payloads.
 *
 * Traversal is depth-limited and prioritizes common wrapper keys first to
 * find useful candidates quickly before falling back to a full walk.
 */
function findWorkingDirectoryInObject(node: unknown, depth = 0): string | null {
  if (!node || depth > 8) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findWorkingDirectoryInObject(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== "object") return null;

  const obj = node as Record<string, unknown>;
  const preferredKeys = [
    "workingDirectory",
    "currentWorkingDirectory",
    "working_directory",
    "current_working_directory",
    "cwd",
    "workdir",
    "workspaceRoot",
    "workspace_root",
    "projectRoot",
    "project_root",
    "rootDir",
    "root_dir",
    "sandboxCwd",
    "sandbox_cwd",
  ];
  for (const key of preferredKeys) {
    const candidate = toPathCandidate(obj[key]);
    if (candidate) return candidate;
  }

  // Check common wrapper objects first.
  const wrappers = [
    "request",
    "context",
    "environment",
    "session",
    "workspace",
    "project",
    "config",
    "client",
    "agent",
    "metadata",
  ];
  for (const key of wrappers) {
    if (key in obj) {
      const found = findWorkingDirectoryInObject(obj[key], depth + 1);
      if (found) return found;
    }
  }

  // Generic fallback: key names that strongly imply cwd.
  for (const [key, value] of Object.entries(obj)) {
    if (
      /(^|_)(cwd|workdir|working_?directory|workspace_?root|project_?root|root_dir|sandbox_?cwd)$/i.test(
        key,
      )
    ) {
      const candidate = toPathCandidate(value);
      if (candidate) return candidate;
    }
  }

  // Last resort recursive walk over remaining fields.
  for (const value of Object.values(obj)) {
    const found = findWorkingDirectoryInObject(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * For OpenAI Responses-style input arrays, extract the first "real" user prompt.
 *
 * Skips boilerplate blocks (AGENTS.md / environment wrappers).
 * Handles both JSON-encoded content (test fixtures) and plain text with
 * contentBlocks (real Codex traffic via mitmproxy where parseResponsesItem
 * already extracted text from the content array).
 */
export function extractUserPrompt(messages: ParsedMessage[]): string | null {
  for (const m of messages) {
    if (m.role !== "user" || !m.content) continue;

    // Determine the actual text to check for boilerplate.
    // Real Codex traffic has plain text in content + contentBlocks with
    // type "input_text"; test fixtures may have JSON-encoded content.
    let text: string | null = null;

    // Try contentBlocks first (real traffic from parseResponsesItem)
    if (m.contentBlocks && m.contentBlocks.length > 0) {
      const block = m.contentBlocks[0] as any;
      if (block.type === "input_text" && block.text) {
        text = block.text;
      }
    }

    // Fall back to JSON-encoded content (test fixtures, some formats)
    if (!text) {
      try {
        const parsed = JSON.parse(m.content);
        if (
          Array.isArray(parsed) &&
          parsed[0] &&
          parsed[0].type === "input_text"
        ) {
          text = parsed[0].text || "";
        }
      } catch {
        // Not JSON and no contentBlocks: skip (not a Responses API message)
      }
    }

    if (!text) continue;
    if (text.startsWith("#") || text.startsWith("<environment")) continue;
    return m.content;
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
export function extractSessionId(
  rawBody: Record<string, any> | null | undefined,
): string | null {
  const userId = rawBody?.metadata?.user_id;
  if (userId) {
    const match = userId.match(/session_([a-f0-9-]+)/);
    if (match) return match[0];
  }
  const geminiSessionId = rawBody?.request?.session_id;
  if (geminiSessionId && typeof geminiSessionId === "string")
    return `gemini_${geminiSessionId}`;
  return null;
}

/**
 * Compute a sub-key to distinguish agents within a session (main vs subagents).
 *
 * Currently derived from the first readable user message.
 */
export function computeAgentKey(contextInfo: ContextInfo): string | null {
  const userMsgs = (contextInfo.messages || []).filter(
    (m) => m.role === "user",
  );
  let realText = "";
  for (const msg of userMsgs) {
    const t = extractReadableText(msg.content);
    if (t) {
      realText = t;
      break;
    }
  }
  if (!realText) return null;
  return createHash("sha256").update(realText).digest("hex").slice(0, 12);
}

/**
 * Compute a conversation fingerprint for grouping.
 *
 * Priority:
 * 1. explicit session IDs (most stable)
 * 2. Responses API chaining (`previous_response_id`)
 * 3. content hash of system + first user prompt
 *
 * For the Responses API (Codex), the first "real" user prompt is used
 * (skipping AGENTS.md and environment boilerplate). This is stable across
 * turns (Codex resends full history) and unique per session.
 */
export function computeFingerprint(
  contextInfo: ContextInfo,
  rawBody: Record<string, any> | null | undefined,
  responseIdToConvo: Map<string, string>,
  source?: string | null,
  workingDirectory?: string | null,
): string | null {
  const sessionId = extractSessionId(rawBody);
  if (sessionId) {
    return createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  }

  if (rawBody?.previous_response_id && responseIdToConvo) {
    const existing = responseIdToConvo.get(rawBody.previous_response_id);
    if (existing) return existing;
  }

  const userMsgs = (contextInfo.messages || []).filter(
    (m) => m.role === "user",
  );

  let promptText: string;
  if (contextInfo.apiFormat === "responses" && userMsgs.length > 1) {
    // For Responses API with multiple user messages (Codex sends AGENTS.md,
    // environment context, and the real prompt as separate items), extract the
    // first non-boilerplate user message for a stable, unique fingerprint.
    promptText = extractUserPrompt(userMsgs) || "";
  } else {
    const firstUser = userMsgs[0];
    promptText = firstUser
      ? (extractReadableText(firstUser.content) ?? firstUser.content)
      : "";
  }

  const systemText = (contextInfo.systemPrompts || [])
    .map((sp) => sp.content)
    .join("\n");

  if (source === "codex") {
    const cwd =
      workingDirectory ?? extractWorkingDirectory(contextInfo, rawBody ?? null);
    if (!systemText && !promptText && !cwd) return null;
    return createHash("sha256")
      .update(`${cwd ?? ""}\0${systemText}\0${promptText}`)
      .digest("hex")
      .slice(0, 16);
  }

  if (!systemText && !promptText) return null;
  return createHash("sha256")
    .update(`${systemText}\0${promptText}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Extract a readable label for a conversation, primarily for UI display.
 */
export function extractConversationLabel(contextInfo: ContextInfo): string {
  const userMsgs = (contextInfo.messages || []).filter(
    (m) => m.role === "user",
  );

  if (contextInfo.apiFormat === "responses" && userMsgs.length > 1) {
    const prompt = extractUserPrompt(userMsgs);
    const text = extractReadableText(prompt);
    if (text) return text.length > 80 ? `${text.slice(0, 77)}...` : text;
  }

  for (let i = userMsgs.length - 1; i >= 0; i--) {
    const text = extractReadableText(userMsgs[i].content);
    if (text) return text.length > 80 ? `${text.slice(0, 77)}...` : text;
  }
  return "Unnamed conversation";
}

/**
 * Extract all tool names used in a conversation's messages.
 *
 * Scans content blocks for tool_use blocks and collects their names.
 *
 * @param messages - Array of messages from one or more entries.
 * @returns Set of tool names that were used.
 */
export function extractToolsUsed(messages: ParsedMessage[]): Set<string> {
  const toolsUsed = new Set<string>();
  for (const msg of messages) {
    if (msg.contentBlocks) {
      for (const block of msg.contentBlocks) {
        if (block.type === "tool_use" && "name" in block && block.name) {
          toolsUsed.add(block.name);
        }
      }
    }
  }
  return toolsUsed;
}
