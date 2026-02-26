import { estimateTokens } from "../core.js";
import type {
  CompositionCategory,
  CompositionEntry,
} from "../lhar-types.generated.js";
import type { ContextInfo } from "../types.js";

export function analyzeComposition(
  contextInfo: ContextInfo,
  rawBody: Record<string, any> | undefined,
): CompositionEntry[] {
  const model = contextInfo.model;
  const counts = new Map<
    CompositionCategory,
    { tokens: number; count: number }
  >();

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
    if (contextInfo.systemTokens > 0)
      add("system_prompt", contextInfo.systemTokens);
    if (contextInfo.toolsTokens > 0)
      add("tool_definitions", contextInfo.toolsTokens);
    if (contextInfo.messagesTokens > 0)
      add("other", contextInfo.messagesTokens);
    return buildCompositionArray(counts, contextInfo.totalTokens);
  }

  // System prompt(s)
  if (rawBody.system) {
    if (typeof rawBody.system === "string") {
      add("system_prompt", estimateTokens(rawBody.system, model));
    } else if (Array.isArray(rawBody.system)) {
      for (const block of rawBody.system) {
        // cache_control metadata is negligible; count only the text content
        add("system_prompt", estimateTokens(block.text || block, model));
      }
    }
  }

  // Instructions (OpenAI Responses API / ChatGPT)
  if (rawBody.instructions) {
    add("system_prompt", estimateTokens(rawBody.instructions, model));
  }

  // Tool definitions
  if (rawBody.tools && Array.isArray(rawBody.tools)) {
    add(
      "tool_definitions",
      estimateTokens(JSON.stringify(rawBody.tools), model),
    );
  }

  // Gemini/Code Assist: unwrap .request wrapper if present
  const geminiBody = rawBody.request || rawBody;
  // Gemini systemInstruction
  if (geminiBody.systemInstruction) {
    const parts = geminiBody.systemInstruction.parts || [];
    add(
      "system_prompt",
      estimateTokens(parts.map((p: any) => p.text || "").join("\n"), model),
    );
  }

  // Gemini contents[] or standard messages[]/input[]
  const messages = geminiBody.contents || rawBody.messages || rawBody.input;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      classifyMessage(msg, add, model);
    }
  } else if (typeof messages === "string") {
    add("user_text", estimateTokens(messages, model));
  }

  const total = Array.from(counts.values()).reduce((s, e) => s + e.tokens, 0);
  return buildCompositionArray(counts, total);
}

function classifyMessage(
  msg: Record<string, any>,
  add: (cat: CompositionCategory, tokens: number) => void,
  model?: string,
): void {
  const type: string = msg.type || "";

  // OpenAI Responses API typed items (no role field)
  if (!msg.role && type) {
    if (type === "function_call" || type === "custom_tool_call") {
      add("tool_calls", estimateTokens(msg, model));
      return;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      add("tool_results", estimateTokens(msg.output || "", model));
      return;
    }
    if (type === "reasoning") {
      add("thinking", estimateTokens(msg, model));
      return;
    }
    if (type === "output_text") {
      add("assistant_text", estimateTokens(msg.text || "", model));
      return;
    }
    if (type === "input_text") {
      add("user_text", estimateTokens(msg.text || "", model));
      return;
    }
  }

  const role: string = msg.role || "user";
  const content = msg.content;

  // System / developer messages
  if (role === "system" || role === "developer") {
    add("system_prompt", estimateTokens(content, model));
    return;
  }

  // String content
  if (typeof content === "string") {
    if (content.includes("<system-reminder>")) {
      add("system_injections", estimateTokens(content, model));
    } else if (role === "assistant") {
      add("assistant_text", estimateTokens(content, model));
    } else {
      add("user_text", estimateTokens(content, model));
    }
    return;
  }

  // Gemini parts array (role + parts instead of role + content)
  if (msg.parts && Array.isArray(msg.parts)) {
    for (const part of msg.parts) {
      classifyGeminiPart(part, role, add, model);
    }
    return;
  }

  // Array of content blocks
  if (Array.isArray(content)) {
    for (const block of content) {
      classifyBlock(block, role, add, model);
    }
    return;
  }

  // Fallback
  if (content) {
    add("other", estimateTokens(content, model));
  }
}

function classifyBlock(
  block: Record<string, any>,
  role: string,
  add: (cat: CompositionCategory, tokens: number) => void,
  model?: string,
): void {
  const type: string = block.type || "";

  if (type === "tool_use") {
    add("tool_calls", estimateTokens(block, model));
    return;
  }
  if (type === "tool_result") {
    add("tool_results", estimateTokens(block.content || "", model));
    return;
  }
  if (type === "thinking") {
    add("thinking", estimateTokens(block.thinking || block.text || "", model));
    return;
  }
  if (type === "image" || type === "image_url") {
    add("images", estimateTokens(block, model)); // estimateTokens handles image blocks with fixed estimate
    return;
  }

  // Text blocks
  const text: string = block.text || "";
  if (type === "text" || type === "input_text" || !type) {
    if (text.includes("<system-reminder>")) {
      add("system_injections", estimateTokens(text, model));
    } else if (block.cache_control) {
      // Count text in its natural category only; the cache_control metadata
      // itself is negligible overhead and should not inflate the total.
      if (role === "assistant") {
        add("assistant_text", estimateTokens(text, model));
      } else {
        add("user_text", estimateTokens(text, model));
      }
    } else if (role === "assistant") {
      add("assistant_text", estimateTokens(text, model));
    } else {
      add("user_text", estimateTokens(text, model));
    }
    return;
  }

  add("other", estimateTokens(block, model));
}

function classifyGeminiPart(
  part: Record<string, any>,
  role: string,
  add: (cat: CompositionCategory, tokens: number) => void,
  model?: string,
): void {
  if (part.text) {
    if (role === "model") {
      add("assistant_text", estimateTokens(part.text, model));
    } else {
      add("user_text", estimateTokens(part.text, model));
    }
    return;
  }
  if (part.functionCall) {
    add("tool_calls", estimateTokens(part.functionCall, model));
    return;
  }
  if (part.functionResponse) {
    add("tool_results", estimateTokens(part.functionResponse, model));
    return;
  }
  if (part.inlineData || part.fileData) {
    add("images", estimateTokens(part, model));
    return;
  }
  if (part.executableCode || part.codeExecutionResult) {
    add("assistant_text", estimateTokens(part, model));
    return;
  }
  add("other", estimateTokens(part, model));
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

/**
 * Normalize composition token counts so their sum equals an authoritative total.
 *
 * Scales each entry proportionally and applies a rounding residual fix on the
 * largest entry so `sum(composition[].tokens) === authoritative` exactly.
 * Also recomputes `pct` fields.
 */
export function normalizeComposition(
  composition: CompositionEntry[],
  authoritative: number,
): void {
  if (composition.length === 0) return;
  const rawSum = composition.reduce((s, c) => s + c.tokens, 0);
  if (rawSum === 0 || authoritative === 0) return;
  if (rawSum === authoritative) {
    // Already matches; just recompute pct for consistency
    for (const c of composition) {
      c.pct =
        authoritative > 0
          ? Math.round((c.tokens / authoritative) * 1000) / 10
          : 0;
    }
    return;
  }
  const scale = authoritative / rawSum;
  let running = 0;
  for (const c of composition) {
    c.tokens = Math.round(c.tokens * scale);
    running += c.tokens;
  }
  // Fix rounding residual on the first (largest) entry
  const residual = authoritative - running;
  if (residual !== 0) {
    composition[0].tokens += residual;
  }
  // Recompute pct
  for (const c of composition) {
    c.pct =
      authoritative > 0
        ? Math.round((c.tokens / authoritative) * 1000) / 10
        : 0;
  }
}
