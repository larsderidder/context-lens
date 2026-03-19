/**
 * Context window waste analysis.
 *
 * Measures how many tokens across a session were "wasted" — paid for but
 * contributing little or nothing to useful output. Waste compounds: a single
 * unused tool definition paid on every turn costs far more than its per-turn
 * size suggests.
 *
 * Waste categories
 * ─────────────────
 * unused_tools   Tool definitions that were never called in the session. Every
 *                turn carries the full definition payload regardless.
 *
 * oversized_results  Tool results that exceed a reasonable size threshold.
 *                Large file reads, search dumps, command output blobs that
 *                could have been truncated or summarised before passing to
 *                the model.
 *
 * repeated_system    The system prompt is re-sent on every turn. Not avoidable
 *                in most APIs, but quantified here as fixed overhead so users
 *                can see what "always on" costs.
 *
 * thinking_spill Extended thinking/reasoning tokens that accumulated beyond a
 *                moderate share of context. Thinking is often useful, but when
 *                it dominates (>40% of tokens) the marginal value is unclear.
 *
 * The "compounding" angle: unlike a one-off cost, waste that appears on turn 1
 * also appears on turns 2..N until the next compaction. The analysis accumulates
 * waste across every turn individually so the true billing impact is visible.
 */

import type { CompositionEntry, ProjectedEntry } from "../types.js";
import { estimateCost } from "./models.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WasteCategory {
  /** Machine key */
  id:
    | "unused_tools"
    | "oversized_results"
    | "repeated_system"
    | "thinking_spill";
  /** Human label */
  label: string;
  /** Total wasted tokens across all turns */
  tokens: number;
  /** Estimated USD cost of the wasted tokens */
  costUsd: number | null;
  /** Per-turn breakdown: [turnIndex, wastedTokens] */
  perTurn: Array<[number, number]>;
  /** Short plain-language description of what this is */
  description: string;
}

export interface WasteAnalysis {
  /** Total input tokens billed across all entries (excluding error responses) */
  totalInputTokens: number;
  /** Total estimated cost of input tokens */
  totalInputCostUsd: number | null;
  /** Total waste tokens across all categories and turns */
  totalWasteTokens: number;
  /** Total estimated cost of wasted tokens */
  totalWasteCostUsd: number | null;
  /** Waste as a fraction of total input tokens (0–1) */
  wasteRatio: number;
  /** Per-category breakdown */
  categories: WasteCategory[];
  /** Tool names that were defined but never called in the session */
  unusedToolNames: string[];
  /** Number of turns analysed (error responses excluded) */
  turnCount: number;
  /** Number of compaction events detected during the session */
  compactionCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Tool result size above which a result is considered "oversized".
 * Below this threshold, tool results are expected and efficient.
 */
const OVERSIZED_RESULT_THRESHOLD = 8_000;

/**
 * Fraction of context at which thinking tokens start to be counted as waste.
 * Below this, thinking is considered worthwhile.
 */
const THINKING_SPILL_THRESHOLD = 0.4;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function categoryTokens(
  composition: CompositionEntry[],
  cat: CompositionEntry["category"],
): number {
  return composition.find((c) => c.category === cat)?.tokens ?? 0;
}

function totalTokens(composition: CompositionEntry[]): number {
  return composition.reduce((s, c) => s + c.tokens, 0);
}

function isSuccessEntry(e: ProjectedEntry): boolean {
  return e.httpStatus === null || (e.httpStatus >= 200 && e.httpStatus < 300);
}

/**
 * Collect tool names defined in an entry's contextInfo.
 */
function definedToolNames(e: ProjectedEntry): Set<string> {
  const names = new Set<string>();
  for (const t of e.contextInfo.tools ?? []) {
    const name =
      "name" in t
        ? (t as { name: string }).name
        : "function" in t
          ? (t as { function: { name: string } }).function.name
          : null;
    if (name) names.add(name);
  }
  return names;
}

/**
 * Collect tool names actually called in an entry's messages (tool_use blocks).
 */
function calledToolNames(e: ProjectedEntry): Set<string> {
  const names = new Set<string>();
  for (const m of e.contextInfo.messages ?? []) {
    if (!m.contentBlocks) continue;
    for (const b of m.contentBlocks) {
      const block = b as unknown as Record<string, unknown>;
      if (block.type === "tool_use" && typeof block.name === "string") {
        names.add(block.name);
      }
    }
  }
  return names;
}

/**
 * Estimate cost for a token count using an entry's model, treating them as
 * input tokens (waste is always on the input side).
 */
function wasteTokenCost(tokens: number, model: string): number | null {
  return estimateCost(model, tokens, 0, 0, 0);
}

// ---------------------------------------------------------------------------
// Per-category analysers
// ---------------------------------------------------------------------------

/**
 * Unused tool definition waste.
 *
 * Tool definitions are bundled on every turn regardless of whether they are
 * ever called. If a tool is never called in the entire session, its definition
 * tokens are wasted on every turn.
 *
 * We compute the unused fraction per turn: (unusedDefs / totalDefs) *
 * toolDefinitionTokens. This is conservative — if half the tools are unused
 * the unused half's share of definition tokens is counted as waste.
 */
function analyseUnusedTools(
  entries: ProjectedEntry[],
  sessionCalledTools: Set<string>,
): { perTurn: Array<[number, number]>; unusedNames: string[] } {
  const perTurn: Array<[number, number]> = [];
  let unusedNames: string[] = [];
  let namesComputed = false;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const defined = definedToolNames(e);
    if (defined.size === 0) {
      perTurn.push([i, 0]);
      continue;
    }

    const unused = [...defined].filter((n) => !sessionCalledTools.has(n));
    if (!namesComputed) {
      unusedNames = unused;
      namesComputed = true;
    }

    const unusedFraction = unused.length / defined.size;
    const defTokens = categoryTokens(e.composition, "tool_definitions");
    const waste = Math.round(defTokens * unusedFraction);
    perTurn.push([i, waste]);
  }

  return { perTurn, unusedNames };
}

/**
 * Oversized tool result waste.
 *
 * Tool results above OVERSIZED_RESULT_THRESHOLD tokens are likely bloated.
 * We count the tokens above the threshold as waste.
 *
 * Note: we only have per-turn total tool_results tokens from composition, not
 * per-result breakdowns (that would require message-level analysis). We use
 * the excess above the threshold as a conservative lower bound.
 */
function analyseOversizedResults(
  entries: ProjectedEntry[],
): Array<[number, number]> {
  return entries.map((e, i) => {
    const resultTokens = categoryTokens(e.composition, "tool_results");
    const waste = Math.max(0, resultTokens - OVERSIZED_RESULT_THRESHOLD);
    return [i, waste] as [number, number];
  });
}

/**
 * Repeated system prompt overhead.
 *
 * The system prompt is re-sent verbatim on every turn. This is not avoidable
 * with most APIs (prompt caching reduces billing cost but the tokens still
 * count toward context). We track it as overhead so users can see what it
 * contributes cumulatively.
 *
 * We count system prompt tokens on every turn *after* turn 0, because the
 * first turn is where the system prompt is genuinely needed. Subsequent
 * repetitions are structural overhead.
 */
function analyseRepeatedSystem(
  entries: ProjectedEntry[],
): Array<[number, number]> {
  return entries.map((e, i) => {
    if (i === 0) return [i, 0] as [number, number];
    const sysTokens =
      categoryTokens(e.composition, "system_prompt") +
      categoryTokens(e.composition, "system_injections");
    return [i, sysTokens] as [number, number];
  });
}

/**
 * Thinking token spill.
 *
 * Thinking blocks beyond 40% of context are counted as spill. At that ratio
 * the thinking cost likely exceeds the value it adds (pure heuristic).
 */
function analyseThinkingSpill(
  entries: ProjectedEntry[],
): Array<[number, number]> {
  return entries.map((e, i) => {
    const total = totalTokens(e.composition);
    if (total === 0) return [i, 0] as [number, number];
    const thinkTokens = categoryTokens(e.composition, "thinking");
    const thinkFraction = thinkTokens / total;
    if (thinkFraction <= THINKING_SPILL_THRESHOLD)
      return [i, 0] as [number, number];
    const spill = Math.round(thinkTokens - total * THINKING_SPILL_THRESHOLD);
    return [i, spill] as [number, number];
  });
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Compute waste analysis for a set of projected entries (a conversation).
 *
 * Only successful (non-error) entries are included. Entries are assumed to be
 * ordered chronologically.
 */
export function computeWasteAnalysis(entries: ProjectedEntry[]): WasteAnalysis {
  const good = entries.filter(isSuccessEntry);

  if (good.length === 0) {
    return {
      totalInputTokens: 0,
      totalInputCostUsd: null,
      totalWasteTokens: 0,
      totalWasteCostUsd: null,
      wasteRatio: 0,
      categories: [],
      unusedToolNames: [],
      turnCount: 0,
      compactionCount: 0,
    };
  }

  // Detect compactions: a compaction is a turn where context shrank vs the
  // previous turn's total (after accounting for the same model/agent chain).
  let compactionCount = 0;
  for (let i = 1; i < good.length; i++) {
    const prev = totalTokens(good[i - 1].composition);
    const cur = totalTokens(good[i].composition);
    if (prev > 0 && cur < prev * 0.7) compactionCount++;
  }

  // Collect all tool names called anywhere in the session (for unused tool calc)
  const sessionCalledTools = new Set<string>();
  for (const e of good) {
    for (const name of calledToolNames(e)) sessionCalledTools.add(name);
  }

  // Total input tokens and cost across all good entries
  let totalInputTokens = 0;
  let totalInputCostUsd: number | null = 0;
  for (const e of good) {
    const input = e.usage?.inputTokens ?? e.contextInfo.totalTokens;
    totalInputTokens += input;
    if (e.costUsd !== null) {
      if (totalInputCostUsd !== null) totalInputCostUsd += e.costUsd;
    } else {
      totalInputCostUsd = null;
    }
  }

  // Run per-category analysers
  const { perTurn: unusedPerTurn, unusedNames } = analyseUnusedTools(
    good,
    sessionCalledTools,
  );
  const oversizedPerTurn = analyseOversizedResults(good);
  const systemPerTurn = analyseRepeatedSystem(good);
  const thinkingPerTurn = analyseThinkingSpill(good);

  // Build category objects
  const model = good[0].contextInfo.model;

  function buildCategory(
    id: WasteCategory["id"],
    label: string,
    description: string,
    perTurn: Array<[number, number]>,
  ): WasteCategory {
    const tokens = perTurn.reduce((s, [, t]) => s + t, 0);
    const cost = tokens > 0 ? wasteTokenCost(tokens, model) : 0;
    return { id, label, description, tokens, costUsd: cost, perTurn };
  }

  const categories: WasteCategory[] = [
    buildCategory(
      "unused_tools",
      "Unused tool definitions",
      `Tool definitions sent on every turn but never called in this session.`,
      unusedPerTurn,
    ),
    buildCategory(
      "oversized_results",
      "Oversized tool results",
      `Tool results exceeding ${(OVERSIZED_RESULT_THRESHOLD / 1000).toFixed(0)}K tokens — likely file dumps or large search results that could be truncated.`,
      oversizedPerTurn,
    ),
    buildCategory(
      "repeated_system",
      "Repeated system prompt",
      "System prompt re-sent verbatim on every turn after the first (unavoidable overhead, but quantified here).",
      systemPerTurn,
    ),
    buildCategory(
      "thinking_spill",
      "Excess thinking tokens",
      `Thinking/reasoning tokens above ${THINKING_SPILL_THRESHOLD * 100}% of context — marginal value unclear.`,
      thinkingPerTurn,
    ),
  ].filter((c) => c.tokens > 0);

  const totalWasteTokens = categories.reduce((s, c) => s + c.tokens, 0);
  const totalWasteCostUsd = categories.reduce<number | null>((s, c) => {
    if (s === null || c.costUsd === null) return null;
    return s + c.costUsd;
  }, 0);

  const wasteRatio =
    totalInputTokens > 0 ? totalWasteTokens / totalInputTokens : 0;

  return {
    totalInputTokens,
    totalInputCostUsd,
    totalWasteTokens,
    totalWasteCostUsd,
    wasteRatio,
    categories,
    unusedToolNames: unusedNames,
    turnCount: good.length,
    compactionCount,
  };
}
