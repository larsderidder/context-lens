/**
 * Importer for OpenAI Codex CLI session files.
 *
 * Session files live at:
 *   ~/.codex/sessions/<year>/<month>/<day>/<id>.jsonl
 *
 * Each line has a "type" field:
 *   - "session_meta"   — session metadata (id, cwd, model, git)
 *   - "response_item"  — individual items in the Responses API input/output
 *                        (message, function_call, function_call_output,
 *                         reasoning, custom_tool_call, ghost_snapshot, ...)
 *   - "event_msg"      — events including "token_count" with per-turn usage
 *   - "turn_context"   — model + cwd snapshot at start of each turn
 *
 * Strategy: collect all response_items in order, then group them into turns
 * by splitting on each assistant "message" item. Per-turn usage comes from
 * the "token_count" event_msg that follows each turn (last_token_usage).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ImportedMessage,
  ImportedSession,
  ImportedTurn,
} from "./types.js";

interface CodexLine {
  timestamp: string;
  type: "session_meta" | "response_item" | "event_msg" | "turn_context";
  payload: Record<string, unknown>;
}

interface TokenCount {
  input_tokens: number;
  cached_input_tokens?: number;
  output_tokens: number;
}

function defaultCodexDir(): string {
  return path.join(os.homedir(), ".codex", "sessions");
}

export function discoverCodexSessions(
  baseDir: string = defaultCodexDir(),
): string[] {
  if (!fs.existsSync(baseDir)) return [];
  const files: string[] = [];

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".jsonl")) {
        files.push(full);
      }
    }
  }

  walk(baseDir);
  return files;
}

export function parseCodexSession(filePath: string): ImportedSession | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const lines: CodexLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as CodexLine;
      if (parsed.type && parsed.payload) lines.push(parsed);
    } catch {
      // skip malformed lines
    }
  }

  if (lines.length === 0) return null;

  // Extract session metadata
  const metaLine = lines.find((l) => l.type === "session_meta");
  if (!metaLine) return null;
  const meta = metaLine.payload;
  const sessionId = meta.id as string | undefined;
  if (!sessionId) return null;

  const cwd = (meta.cwd as string) ?? null;
  const gitBranch =
    ((meta.git as Record<string, unknown> | undefined)?.branch as string) ??
    null;

  // Find model from turn_context lines
  let model = "gpt-4o";
  for (const line of lines) {
    if (line.type === "turn_context" && line.payload.model) {
      model = line.payload.model as string;
      break;
    }
  }

  // Collect response_items and token_count events in order
  const responseItems: {
    timestamp: string;
    payload: Record<string, unknown>;
  }[] = [];
  const tokenCounts: { timestamp: string; last: TokenCount }[] = [];

  for (const line of lines) {
    if (line.type === "response_item") {
      responseItems.push({ timestamp: line.timestamp, payload: line.payload });
    } else if (line.type === "event_msg") {
      const p = line.payload as Record<string, unknown>;
      if (
        p.type === "token_count" &&
        p.info &&
        typeof p.info === "object" &&
        (p.info as Record<string, unknown>).last_token_usage
      ) {
        const info = p.info as Record<string, unknown>;
        tokenCounts.push({
          timestamp: line.timestamp,
          last: info.last_token_usage as TokenCount,
        });
      }
    }
  }

  if (responseItems.length === 0) return null;

  // Group response_items into turns.
  // A new turn starts when we see an assistant "message" item.
  // Everything before the first assistant message is the initial user context.
  const turns: ImportedTurn[] = [];
  let currentItems: Record<string, unknown>[] = [];
  let currentTimestamp =
    responseItems[0]?.timestamp ?? new Date().toISOString();
  let tokenCountIndex = 0;

  // Accumulated messages across all turns (context window snapshot per turn)
  const accumulated: ImportedMessage[] = [];

  for (const item of responseItems) {
    const p = item.payload;
    const pType = p.type as string;
    const pRole = p.role as string | undefined;

    if (pRole === "assistant" && pType === "message") {
      // End of a turn — flush accumulated + current assistant message
      accumulated.push({ role: "assistant", content: p.content });
      currentItems.push(p);

      // Find the next token_count event after this timestamp
      let usage: TokenCount | null = null;
      while (tokenCountIndex < tokenCounts.length) {
        const tc = tokenCounts[tokenCountIndex];
        if (tc.timestamp >= item.timestamp) {
          usage = tc.last;
          tokenCountIndex++;
          break;
        }
        tokenCountIndex++;
      }

      let inputTokens: number | null = null;
      if (usage) {
        // Codex reports cached input as a subset of its inclusive input count.
        inputTokens = Math.max(
          0,
          usage.input_tokens - (usage.cached_input_tokens ?? 0),
        );
      }
      turns.push({
        timestamp: item.timestamp,
        messages: [...accumulated],
        inputTokens,
        outputTokens: usage?.output_tokens ?? null,
        cacheReadTokens: usage?.cached_input_tokens ?? null,
        cacheWriteTokens: null,
      });

      currentItems = [];
      currentTimestamp = item.timestamp;
    } else if (pRole === "user" && pType === "message") {
      accumulated.push({ role: "user", content: p.content });
      currentItems.push(p);
    } else {
      // function_call, function_call_output, reasoning, custom_tool_call, etc.
      // These are assistant-side items — add to accumulated as assistant content
      // so tool calls are visible in the analysis
      currentItems.push(p);
    }
  }

  if (turns.length === 0) return null;

  return {
    sessionId,
    source: "codex",
    model,
    provider: "openai",
    apiFormat: "responses",
    cwd,
    gitBranch,
    turns,
  };
}
