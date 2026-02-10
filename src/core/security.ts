import type {
  AlertSeverity,
  ContextInfo,
  ParsedMessage,
  SecurityAlert,
  SecurityResult,
  SecuritySummary,
} from "../types.js";

// ---------------------------------------------------------------------------
// Tier 1: Pattern matching — known injection phrases
// ---------------------------------------------------------------------------

interface PatternRule {
  id: string;
  severity: AlertSeverity;
  pattern: RegExp;
}

const TIER1_PATTERNS: PatternRule[] = [
  // Role hijacking
  {
    id: "role_hijack_ignore",
    severity: "high",
    pattern:
      /ignore\s+(?:all\s+)?(?:previous|prior|above|earlier|preceding)\s+instructions/i,
  },
  {
    id: "role_hijack_disregard",
    severity: "high",
    pattern:
      /disregard\s+(?:all\s+)?(?:previous|prior|above|earlier|your)\s+(?:instructions|directives|rules|guidelines)/i,
  },
  {
    id: "role_hijack_forget",
    severity: "high",
    pattern:
      /forget\s+(?:all\s+)?(?:previous|prior|above|earlier|your)\s+(?:instructions|directives|rules|context)/i,
  },
  {
    id: "role_hijack_new_instructions",
    severity: "high",
    pattern:
      /(?:your\s+new\s+instructions\s+are|from\s+now\s+on\s+you\s+(?:are|will|must|should))/i,
  },
  {
    id: "role_hijack_override",
    severity: "high",
    pattern: /system\s*prompt\s*override/i,
  },
  {
    id: "role_hijack_act_as",
    severity: "high",
    pattern:
      /(?:you\s+are\s+now|act\s+as|pretend\s+(?:to\s+be|you\s+are))\s+(?:DAN|an?\s+unrestricted|an?\s+unfiltered|jailbroken|evil)/i,
  },

  // Known jailbreak templates
  {
    id: "jailbreak_dan",
    severity: "high",
    pattern: /\bDAN\s*(?:mode|prompt|jailbreak|\d+\.\d+)\b/i,
  },
  {
    id: "jailbreak_developer_mode",
    severity: "high",
    pattern: /(?:developer|god)\s*mode\s*(?:enabled|activated|on)\b/i,
  },
  {
    id: "jailbreak_do_anything_now",
    severity: "high",
    pattern: /do\s+anything\s+now/i,
  },

  // Chat template tokens in content (should never appear in user/tool messages)
  {
    id: "chat_template_inst",
    severity: "high",
    pattern: /\[INST\]|\[\/INST\]/,
  },
  {
    id: "chat_template_im",
    severity: "high",
    pattern: /<\|im_start\|>|<\|im_end\|>/,
  },
  {
    id: "chat_template_special",
    severity: "high",
    pattern: /<\|(?:system|user|assistant|endof(?:text|turn)|sep|pad)\|>/,
  },

  // Base64-encoded instruction blocks (heuristic: long base64 string > 100 chars)
  {
    id: "base64_block",
    severity: "medium",
    pattern: /(?:^|[\s:=])([A-Za-z0-9+/]{100,}={0,2})(?:$|[\s])/m,
  },

  // HTML/Markdown injection hiding content
  {
    id: "html_hidden_text",
    severity: "medium",
    pattern:
      /<!--[\s\S]*?(?:ignore|instruction|system|prompt|override)[\s\S]*?-->/i,
  },
  {
    id: "html_invisible_style",
    severity: "medium",
    pattern:
      /style\s*=\s*["'][^"']*(?:font-size\s*:\s*0|display\s*:\s*none|visibility\s*:\s*hidden|color\s*:\s*(?:white|#fff(?:fff)?|rgba?\([^)]*,\s*0\)))[^"']*["']/i,
  },

  // Prompt leaking attempts
  {
    id: "prompt_leak_request",
    severity: "medium",
    pattern:
      /(?:reveal|show|display|output|print|repeat|echo)\s+(?:your\s+)?(?:system\s+prompt|instructions|initial\s+prompt|hidden\s+prompt|original\s+prompt)/i,
  },
];

// ---------------------------------------------------------------------------
// Tier 2: Heuristic analysis — structural anomalies
// ---------------------------------------------------------------------------

/**
 * Detect role confusion: imperative AI instructions appearing in tool results.
 * Only scans tool_result content blocks.
 */
const ROLE_CONFUSION_PATTERNS: RegExp[] = [
  /\bas\s+an?\s+AI\b.*?\byou\s+(?:must|should|will|are)\b/i,
  /\byou\s+are\s+an?\s+(?:helpful|AI|language\s+model|assistant)\b/i,
  /\brespond\s+(?:only\s+)?(?:in|with)\b.*?\bformat\b/i,
  /\balways\s+(?:respond|reply|answer|say)\b/i,
  /\bnever\s+(?:mention|reveal|disclose|say|tell)\b/i,
];

/**
 * Detect unusual Unicode: zero-width characters, RTL overrides, homoglyphs.
 */
const SUSPICIOUS_UNICODE: RegExp =
  /[\u200B-\u200F\u2028-\u202F\uFEFF\u061C\u115F\u1160\u17B4\u17B5\u180E\u2000-\u200A\u2060-\u2064\u2066-\u2069\u206A-\u206F]|\u00AD|\u034F/;

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

function extractToolName(
  msg: ParsedMessage,
  allMessages: ParsedMessage[],
): string | null {
  if (!msg.contentBlocks) return null;

  // Build tool_use_id -> name map from all messages
  const nameMap = new Map<string, string>();
  for (const m of allMessages) {
    if (m.contentBlocks) {
      for (const b of m.contentBlocks) {
        if (b.type === "tool_use" && b.id && b.name) {
          nameMap.set(b.id, b.name);
        }
      }
    }
  }

  for (const b of msg.contentBlocks) {
    if (b.type === "tool_use" && b.name) return b.name;
    if (b.type === "tool_result" && b.tool_use_id) {
      return nameMap.get(b.tool_use_id) || null;
    }
  }
  return null;
}

function isToolResultMessage(msg: ParsedMessage): boolean {
  if (!msg.contentBlocks) return false;
  return msg.contentBlocks.some((b) => b.type === "tool_result");
}

function truncateMatch(text: string, start: number, length: number): string {
  const snippet = text.slice(start, start + length);
  return snippet.length > 120 ? `${snippet.slice(0, 117)}...` : snippet;
}

function scanMessage(
  msg: ParsedMessage,
  messageIndex: number,
  allMessages: ParsedMessage[],
): SecurityAlert[] {
  const alerts: SecurityAlert[] = [];
  const content = msg.content || "";
  if (!content) return alerts;

  // Skip system messages — they are authored by the developer, not injected
  if (msg.role === "system" || msg.role === "developer") return alerts;

  const toolName = extractToolName(msg, allMessages);
  const isToolResult = isToolResultMessage(msg);

  // --- Tier 1: Pattern matching ---
  for (const rule of TIER1_PATTERNS) {
    const match = rule.pattern.exec(content);
    if (match) {
      alerts.push({
        messageIndex,
        role: msg.role,
        toolName,
        severity: rule.severity,
        pattern: rule.id,
        match: truncateMatch(content, match.index, match[0].length),
        offset: match.index,
        length: match[0].length,
      });
    }
  }

  // --- Tier 2: Role confusion (only in tool results) ---
  if (isToolResult) {
    for (const pat of ROLE_CONFUSION_PATTERNS) {
      const match = pat.exec(content);
      if (match) {
        alerts.push({
          messageIndex,
          role: msg.role,
          toolName,
          severity: "medium",
          pattern: "role_confusion",
          match: truncateMatch(content, match.index, match[0].length),
          offset: match.index,
          length: match[0].length,
        });
        break; // One role confusion alert per message is enough
      }
    }
  }

  // --- Tier 2: Suspicious Unicode ---
  const unicodeMatch = SUSPICIOUS_UNICODE.exec(content);
  if (unicodeMatch) {
    // Count total suspicious chars
    const count = (
      content.match(new RegExp(SUSPICIOUS_UNICODE.source, "g")) || []
    ).length;
    alerts.push({
      messageIndex,
      role: msg.role,
      toolName,
      severity: "info",
      pattern: "suspicious_unicode",
      match: `${count} suspicious Unicode character${count > 1 ? "s" : ""} (zero-width, RTL override, etc.)`,
      offset: unicodeMatch.index,
      length: 1,
    });
  }

  return alerts;
}

/**
 * Scan all messages in a context for prompt injection patterns.
 *
 * This is the main entry point, called from Store.storeRequest() before compaction.
 */
export function scanSecurity(contextInfo: ContextInfo): SecurityResult {
  const alerts: SecurityAlert[] = [];

  for (let i = 0; i < contextInfo.messages.length; i++) {
    const msgAlerts = scanMessage(
      contextInfo.messages[i],
      i,
      contextInfo.messages,
    );
    alerts.push(...msgAlerts);
  }

  const summary: SecuritySummary = { high: 0, medium: 0, info: 0 };
  for (const alert of alerts) {
    summary[alert.severity]++;
  }

  return { alerts, summary };
}
