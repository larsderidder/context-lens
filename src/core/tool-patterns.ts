/**
 * Tool call pattern detection.
 *
 * Scans the message sequence in a single captured entry for behavioural
 * anti-patterns that suggest the agent is wasting context or stuck.
 * All checks are structural — no LLM calls, no text analysis.
 *
 * Three beta heuristics:
 *   1. Redundant calls   — same tool + same args called >1x in one turn
 *   2. Re-fetch          — read/bash on a path already in context from a prior turn
 *   3. Stuck on error    — tool returned an error, called again unchanged
 *
 * All messageIndex values are relative to the current entry's messages array.
 * Cross-turn context is passed as pre-extracted sets, not raw messages.
 */

import type { ParsedMessage, ToolResultBlock, ToolUseBlock } from "../types.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type ToolPatternKind = "redundant_call" | "refetch" | "stuck_on_error";

export interface ToolPatternFinding {
  kind: ToolPatternKind;
  /** Human-readable title */
  title: string;
  detail: string;
  /** Tool name(s) involved */
  toolNames: string[];
  /**
   * Index into the current entry's contextInfo.messages array.
   * -1 for cross-turn findings where the offending call is in a prior entry.
   */
  messageIndex: number;
}

export interface ToolPatternResult {
  findings: ToolPatternFinding[];
  /** Paths read/executed in this entry — pass to next entry as previousFetchedPaths */
  fetchedPaths: Set<string>;
}

/**
 * Pre-extracted context from previous entries in the same conversation.
 * Build this once per conversation by accumulating ToolPatternResult.fetchedPaths.
 */
export interface PreviousTurnContext {
  /** Paths that were read/executed in earlier turns and are already in context */
  fetchedPaths: Set<string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stable key for a tool call: name + canonical JSON of input */
function callKey(name: string, input: Record<string, unknown>): string {
  return `${name}::${JSON.stringify(input, Object.keys(input).sort())}`;
}

/** Extract a path/command string from a tool_use input for re-fetch detection */
function extractPathArg(
  _toolName: string,
  input: Record<string, unknown>,
): string | null {
  const PATH_KEYS = ["path", "file", "filename", "filepath", "command", "cmd"];
  for (const key of PATH_KEYS) {
    if (typeof input[key] === "string") return input[key] as string;
  }
  if (Array.isArray(input.args) && typeof input.args[0] === "string") {
    return input.args[0] as string;
  }
  return null;
}

/**
 * Tools that read static content — their output is deterministic given the
 * same path, so calling them again with the same path is redundant.
 * Excludes bash/shell/execute: running the same command twice is often
 * intentional (e.g. checking filesystem state after an action).
 */
const PURE_READ_TOOLS = new Set([
  "read",
  "read_file",
  "readfile",
  "cat",
  "view",
  "open",
]);

function isReadLikeTool(name: string): boolean {
  return PURE_READ_TOOLS.has(name.toLowerCase());
}

/** Check whether a tool result content looks like an error */
function isErrorResult(content: string): boolean {
  if (!content) return false;
  const lower = content.toLowerCase();
  return (
    lower.includes("error:") ||
    lower.includes("enoent") ||
    lower.includes("permission denied") ||
    lower.includes("command not found") ||
    lower.includes("no such file") ||
    lower.includes("failed:") ||
    lower.includes("exception:") ||
    lower.includes("traceback") ||
    /exit code [1-9]/.test(lower) ||
    /exited with [1-9]/.test(lower)
  );
}

function resultContent(block: ToolResultBlock): string {
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) {
    return block.content
      .map((b) => ("text" in b ? (b as { text: string }).text : ""))
      .join("\n");
  }
  return "";
}

// ---------------------------------------------------------------------------
// Extract tool call/result pairs from a message sequence
// ---------------------------------------------------------------------------

interface ToolCall {
  /** Index into the messages array passed to detectToolPatterns */
  msgIndex: number;
  block: ToolUseBlock;
}

interface ToolResult {
  msgIndex: number;
  block: ToolResultBlock;
}

function extractToolCalls(messages: ParsedMessage[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (let i = 0; i < messages.length; i++) {
    for (const b of messages[i].contentBlocks ?? []) {
      if (b.type === "tool_use") {
        calls.push({ msgIndex: i, block: b as ToolUseBlock });
      }
    }
  }
  return calls;
}

function extractToolResults(messages: ParsedMessage[]): ToolResult[] {
  const results: ToolResult[] = [];
  for (let i = 0; i < messages.length; i++) {
    for (const b of messages[i].contentBlocks ?? []) {
      if (b.type === "tool_result") {
        results.push({ msgIndex: i, block: b as ToolResultBlock });
      }
    }
  }
  return results;
}

function buildResultMap(results: ToolResult[]): Map<string, ToolResult> {
  const map = new Map<string, ToolResult>();
  for (const r of results) map.set(r.block.tool_use_id, r);
  return map;
}

// ---------------------------------------------------------------------------
// Heuristic 1: Redundant calls
// Same tool + identical input called more than once within this entry.
// ---------------------------------------------------------------------------

function detectRedundantCalls(calls: ToolCall[]): ToolPatternFinding[] {
  const seen = new Map<string, ToolCall>();
  const findings: ToolPatternFinding[] = [];
  const reported = new Set<string>();

  for (const call of calls) {
    const key = callKey(call.block.name, call.block.input ?? {});
    if (seen.has(key) && !reported.has(key)) {
      findings.push({
        kind: "redundant_call",
        title: `Redundant tool call: ${call.block.name}`,
        detail: `Called with identical arguments more than once in this turn.`,
        toolNames: [call.block.name],
        messageIndex: call.msgIndex,
      });
      reported.add(key);
    } else {
      seen.set(key, call);
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Heuristic 2: Re-fetching known content (within-turn)
// A read-like tool is called on a path whose result is already in this entry's
// message sequence (i.e. the content was read earlier in the same turn).
// ---------------------------------------------------------------------------

function detectRefetches(
  calls: ToolCall[],
  resultMap: Map<string, ToolResult>,
): { findings: ToolPatternFinding[]; fetchedPaths: Set<string> } {
  // Accumulate fetched paths as we walk through calls in message order
  const fetchedPaths = new Set<string>();
  const findings: ToolPatternFinding[] = [];
  const reported = new Set<string>();

  // Sort calls by message index
  const sorted = [...calls].sort((a, b) => a.msgIndex - b.msgIndex);

  for (const call of sorted) {
    if (!isReadLikeTool(call.block.name)) continue;
    const p = extractPathArg(call.block.name, call.block.input ?? {});
    if (!p) continue;

    if (fetchedPaths.has(p) && !reported.has(p)) {
      findings.push({
        kind: "refetch",
        title: `Re-reading already-fetched content: ${call.block.name}`,
        detail: `"${p}" was already fetched earlier in this turn and its result is in context.`,
        toolNames: [call.block.name],
        messageIndex: call.msgIndex,
      });
      reported.add(p);
    }

    // Mark as fetched once its result has been returned
    const result = resultMap.get(call.block.id);
    if (result) fetchedPaths.add(p);
  }

  return { findings, fetchedPaths };
}

// ---------------------------------------------------------------------------
// Heuristic 2b: Cross-turn re-fetch
// A read-like tool is called on a path that was fetched in a *previous* entry
// in the same conversation. The content is already in context from history.
// messageIndex = -1 because the original fetch is in a prior entry.
// ---------------------------------------------------------------------------

function detectCrossTurnRefetches(
  calls: ToolCall[],
  previousFetchedPaths: Set<string>,
): ToolPatternFinding[] {
  const findings: ToolPatternFinding[] = [];
  const reported = new Set<string>();

  for (const call of calls) {
    if (!isReadLikeTool(call.block.name)) continue;
    const p = extractPathArg(call.block.name, call.block.input ?? {});
    if (!p || !previousFetchedPaths.has(p) || reported.has(p)) continue;

    findings.push({
      kind: "refetch",
      title: `Re-reading prior-turn content: ${call.block.name}`,
      detail: `"${p}" was already read in a previous turn and is still in context.`,
      toolNames: [call.block.name],
      messageIndex: call.msgIndex,
    });
    reported.add(p);
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Heuristic 3: Stuck on error
// A tool returned an error and was called again with the same arguments.
// ---------------------------------------------------------------------------

function detectStuckOnError(
  calls: ToolCall[],
  resultMap: Map<string, ToolResult>,
): ToolPatternFinding[] {
  const findings: ToolPatternFinding[] = [];
  const reported = new Set<string>();

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    const result = resultMap.get(call.block.id);
    if (!result) continue;

    const content = resultContent(result.block);
    if (!isErrorResult(content)) continue;

    const key = callKey(call.block.name, call.block.input ?? {});
    if (reported.has(key)) continue;

    for (let j = i + 1; j < calls.length; j++) {
      const retry = calls[j];
      if (callKey(retry.block.name, retry.block.input ?? {}) === key) {
        findings.push({
          kind: "stuck_on_error",
          title: `Stuck on error: ${call.block.name}`,
          detail: `Tool returned an error but was retried with identical arguments.`,
          toolNames: [call.block.name],
          messageIndex: retry.msgIndex,
        });
        reported.add(key);
        break;
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect tool call anti-patterns in a single entry's messages.
 *
 * Pass `previousContext.fetchedPaths` (accumulated from prior entries) to
 * enable cross-turn re-fetch detection. Build this by accumulating
 * `result.fetchedPaths` across entries as you process a conversation.
 */
export function detectToolPatterns(
  messages: ParsedMessage[],
  previousContext?: PreviousTurnContext,
): ToolPatternResult {
  const calls = extractToolCalls(messages);
  if (calls.length === 0) {
    return { findings: [], fetchedPaths: new Set() };
  }

  const results = extractToolResults(messages);
  const resultMap = buildResultMap(results);

  const { findings: refetchFindings, fetchedPaths } = detectRefetches(
    calls,
    resultMap,
  );

  const findings: ToolPatternFinding[] = [
    ...detectRedundantCalls(calls),
    ...refetchFindings,
    ...detectStuckOnError(calls, resultMap),
  ];

  if (previousContext?.fetchedPaths.size) {
    findings.push(
      ...detectCrossTurnRefetches(calls, previousContext.fetchedPaths),
    );
  }

  // Merge current fetched paths with previous for the accumulated set
  const allFetched = new Set<string>(previousContext?.fetchedPaths ?? []);
  for (const p of fetchedPaths) allFetched.add(p);

  return { findings, fetchedPaths: allFetched };
}
