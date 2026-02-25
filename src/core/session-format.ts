/**
 * Human-readable formatting for session analysis results.
 *
 * Produces the text output for `context-lens analyze`.
 */

import type { CompositionEntry, LharRecord } from "../lhar-types.generated.js";
import type { SessionAnalysis } from "./session-analysis.js";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function fmtCost(c: number | null): string {
  if (c === null || c === 0) return "-";
  if (c < 0.01) return `$${c.toFixed(4)}`;
  return `$${c.toFixed(2)}`;
}

export function shortModel(m: string): string {
  const replacements: Record<string, string> = {
    "claude-opus-4-6": "opus-4.6",
    "claude-sonnet-4-5-2025": "sonnet-4.5",
    "claude-sonnet-4-2025": "sonnet-4",
    "claude-haiku-4-5-2025": "haiku-4.5",
    "claude-3-5-sonnet-2024": "sonnet-3.5",
    "claude-3-5-haiku-2024": "haiku-3.5",
  };
  for (const [prefix, short] of Object.entries(replacements)) {
    if (m.startsWith(prefix)) return short;
  }
  if (m.length > 25) return `${m.slice(0, 22)}...`;
  return m;
}

export function fmtDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const secs = ms / 1_000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = Math.round(secs % 60);
  if (mins < 60) return `${mins}m ${remainSecs}s`;
  const hrs = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hrs}h ${remainMins}m`;
}

function pad(s: string, width: number, right = false): string {
  if (right) return s.padStart(width);
  return s.padEnd(width);
}

// ---------------------------------------------------------------------------
// Composition table
// ---------------------------------------------------------------------------

function formatComposition(
  composition: CompositionEntry[],
  indent: string,
): string[] {
  if (composition.length === 0) return [`${indent}(no composition data)`];

  const total = composition.reduce((s, c) => s + c.tokens, 0);
  const lines: string[] = [];
  lines.push(
    `${indent}${pad("Category", 22)} ${pad("Tokens", 10, true)} ${pad("%", 7, true)} ${pad("Count", 6, true)}`,
  );
  lines.push(`${indent}${"-".repeat(48)}`);

  const sorted = [...composition].sort((a, b) => b.tokens - a.tokens);
  for (const c of sorted) {
    if (c.tokens === 0) continue;
    const pct =
      c.pct || (total > 0 ? Math.round((c.tokens / total) * 1000) / 10 : 0);
    lines.push(
      `${indent}${pad(c.category, 22)} ${pad(fmtTokens(c.tokens), 10, true)} ${pad(`${pct.toFixed(1)}%`, 7, true)} ${pad(String(c.count), 6, true)}`,
    );
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Full text output
// ---------------------------------------------------------------------------

export interface FormatOptions {
  showPath?: boolean;
  /** "last" | "pre-compaction" | number (turn number, 1-indexed) */
  composition?: string;
  /** Parsed entries, needed when --composition=N is used to look up a specific turn */
  entries?: LharRecord[];
}

export function formatSessionAnalysis(
  a: SessionAnalysis,
  opts: FormatOptions = {},
): string {
  const { showPath = true, composition: compositionArg } = opts;
  const lines: string[] = [];

  // Header
  lines.push("=".repeat(70));
  lines.push(`SESSION ANALYSIS: ${a.filename}`);
  lines.push("=".repeat(70));
  lines.push(`  Tool:            ${a.tool}`);
  lines.push(`  Primary model:   ${a.primaryModel}`);
  lines.push(`  Started:         ${a.startedAt}`);
  lines.push(
    `  Total entries:   ${a.totalEntries} (${a.mainEntries} main, ${a.subagentEntries} subagent)`,
  );
  lines.push(`  User turns:      ${a.userTurns.length}`);
  lines.push(`  Compactions:     ${a.compactions.length}`);
  lines.push(`  Total cost:      ${fmtCost(a.totalCostUsd)}`);
  if (a.timing.wallTimeMs > 0) {
    lines.push(`  Wall time:       ${fmtDuration(a.timing.wallTimeMs)}`);
  }
  if (a.cache.totalCacheReadTokens > 0 || a.cache.totalCacheWriteTokens > 0) {
    lines.push(
      `  Cache hit rate:  ${(a.cache.cacheHitRate * 100).toFixed(1)}%`,
    );
  }
  lines.push("");

  // Context timeline
  lines.push("CONTEXT TIMELINE (cumulative tokens per entry)");
  lines.push("-".repeat(70));
  if (a.contextTimeline.length > 0) {
    const maxTok = Math.max(...a.contextTimeline.map((t) => t[1]));
    const width = 50;
    const compactionIndices = new Set(a.compactions.map((c) => c.entryIndex));
    for (const [entryIdx, tokens] of a.contextTimeline) {
      const barLen = maxTok > 0 ? Math.floor((tokens / maxTok) * width) : 0;
      const bar = "\u2588".repeat(barLen);
      const marker = compactionIndices.has(entryIdx) ? " << COMPACTION" : "";
      lines.push(
        `  #${pad(String(entryIdx), 3, true)} ${pad(fmtTokens(tokens), 8, true)} |${bar}${marker}`,
      );
    }
  }
  lines.push("");

  // Compaction events
  if (a.compactions.length > 0) {
    lines.push(`COMPACTION EVENTS (${a.compactions.length} total)`);
    lines.push("-".repeat(70));
    lines.push(
      `  ${pad("#", 4, true)} ${pad("Entry", 6, true)} ${pad("Seq", 5, true)} ${pad("Before", 10, true)} ${pad("After", 10, true)} ${pad("Lost", 10, true)} ${pad("%", 7, true)}`,
    );
    for (let i = 0; i < a.compactions.length; i++) {
      const c = a.compactions[i];
      lines.push(
        `  ${pad(String(i + 1), 4, true)} ${pad(String(c.entryIndex), 6, true)} ${pad(String(c.sequence), 5, true)} ${pad(fmtTokens(c.beforeTokens), 10, true)} ${pad(fmtTokens(c.afterTokens), 10, true)} ${pad(fmtTokens(c.tokensLost), 10, true)} ${pad(`${c.pctLost.toFixed(1)}%`, 7, true)}`,
      );
    }
    lines.push("");
  }

  // Growth blocks
  if (a.growthBlocks.length > 0) {
    lines.push(
      `GROWTH BLOCKS (${a.growthBlocks.length} contiguous increasing stretches)`,
    );
    lines.push("-".repeat(70));
    const interesting = a.growthBlocks.filter((b) => b.numEntries > 1);
    if (interesting.length > 0) {
      lines.push(
        `  ${pad("#", 4, true)} ${pad("Entries", 8, true)} ${pad("Start", 10, true)} ${pad("End", 10, true)} ${pad("Gained", 10, true)} ${pad("Rate/turn", 12, true)}`,
      );
      for (let i = 0; i < interesting.length; i++) {
        const b = interesting[i];
        lines.push(
          `  ${pad(String(i + 1), 4, true)} ${pad(String(b.numEntries), 8, true)} ${pad(fmtTokens(b.startTokens), 10, true)} ${pad(fmtTokens(b.endTokens), 10, true)} ${pad(fmtTokens(b.tokensGained), 10, true)} ${pad(`${fmtTokens(Math.round(b.ratePerTurn))}/t`, 10, true)}`,
        );
      }
    } else {
      lines.push(
        "  (no multi-entry growth blocks; context fluctuates rapidly)",
      );
    }
    lines.push("");
  }

  // User turns
  if (a.userTurns.length > 0) {
    lines.push(`USER TURNS (${a.userTurns.length} turns)`);
    lines.push("-".repeat(70));
    lines.push(
      `  ${pad("Turn", 5, true)} ${pad("Calls", 6, true)} ${pad("Models", 25, true)} ${pad("Peak ctx", 10, true)} ${pad("Cost", 10, true)} ${pad("Compactions", 12, true)}`,
    );
    for (const t of a.userTurns) {
      let modelsStr = t.modelsUsed.map(shortModel).join(", ");
      if (modelsStr.length > 25) modelsStr = `${modelsStr.slice(0, 22)}...`;
      lines.push(
        `  ${pad(String(t.turnNumber), 5, true)} ${pad(String(t.numApiCalls), 6, true)} ${pad(modelsStr, 25, true)} ${pad(fmtTokens(t.peakContextTokens), 10, true)} ${pad(fmtCost(t.totalCost), 10, true)} ${pad(String(t.compactionsInTurn), 12, true)}`,
      );
    }
    lines.push("");
  }

  // Agent path trace
  if (showPath && a.agentPaths.length > 0) {
    lines.push("AGENT PATH TRACE");
    lines.push("-".repeat(70));
    for (let turnIdx = 0; turnIdx < a.agentPaths.length; turnIdx++) {
      const path = a.agentPaths[turnIdx];
      const turn = a.userTurns[turnIdx];
      const label = turn ? `Turn ${turn.turnNumber}` : `Turn ${turnIdx + 1}`;
      lines.push("");
      lines.push(`  ${label}:`);
      for (const step of path) {
        const m = shortModel(step.model);
        const roleTag = step.agentRole ? `[${step.agentRole}]` : "";
        const cost = fmtCost(step.costUsd);
        const ctx = fmtTokens(step.contextTokens);

        if (step.action === "compaction") {
          lines.push(
            `    seq=${pad(String(step.sequence), 3, true)}  ${pad(roleTag, 12)} ${pad(m, 18)} !! COMPACTION  ctx=${ctx}`,
          );
        } else if (step.action === "tool_use") {
          lines.push(
            `    seq=${pad(String(step.sequence), 3, true)}  ${pad(roleTag, 12)} ${pad(m, 18)} -> tool_use     ctx=${ctx}  cost=${cost}`,
          );
        } else if (step.action === "end_turn") {
          lines.push(
            `    seq=${pad(String(step.sequence), 3, true)}  ${pad(roleTag, 12)} ${pad(m, 18)} => end_turn     ctx=${ctx}  cost=${cost}`,
          );
        } else {
          lines.push(
            `    seq=${pad(String(step.sequence), 3, true)}  ${pad(roleTag, 12)} ${pad(m, 18)}    ${pad(step.action, 14)} ctx=${ctx}  cost=${cost}`,
          );
        }
      }
    }
    lines.push("");
  }

  // Composition breakdowns
  let showLast = true;
  let showPreCompaction = false;
  let specificTurn: number | null = null;

  if (compositionArg) {
    if (compositionArg === "last") {
      showLast = true;
    } else if (compositionArg === "pre-compaction") {
      showPreCompaction = true;
      showLast = false;
    } else {
      const parsed = parseInt(compositionArg, 10);
      if (!isNaN(parsed)) {
        specificTurn = parsed;
        showLast = false;
      }
    }
  }

  if (showLast) {
    lines.push("COMPOSITION (last entry)");
    lines.push("-".repeat(70));
    lines.push(...formatComposition(a.compositionLast, "  "));
    lines.push("");
  }

  if (showPreCompaction && a.compositionsPreCompaction.length > 0) {
    lines.push(
      `COMPOSITION BEFORE COMPACTIONS (${a.compositionsPreCompaction.length} snapshots)`,
    );
    lines.push("-".repeat(70));
    for (const [entryIdx, comp] of a.compositionsPreCompaction) {
      lines.push(`  Entry #${entryIdx}:`);
      lines.push(...formatComposition(comp, "    "));
      lines.push("");
    }
  }

  if (specificTurn !== null && opts.entries) {
    if (specificTurn > 0 && specificTurn <= a.userTurns.length) {
      const turn = a.userTurns[specificTurn - 1];
      const entryIdx = Math.min(turn.endEntryIndex, opts.entries.length - 1);
      const entry = opts.entries[entryIdx];
      if (entry) {
        lines.push(`COMPOSITION (turn ${specificTurn}, entry #${entryIdx})`);
        lines.push("-".repeat(70));
        lines.push(...formatComposition(entry.context_lens.composition, "  "));
        lines.push("");
      }
    } else {
      lines.push(
        `Turn ${specificTurn} is out of range (session has ${a.userTurns.length} turns)`,
      );
    }
  }

  // Summary statistics
  lines.push("SUMMARY STATISTICS");
  lines.push("-".repeat(70));
  if (a.contextTimeline.length > 0) {
    const tokensList = a.contextTimeline.map((t) => t[1]);
    lines.push(
      `  Peak context:          ${fmtTokens(Math.max(...tokensList))}`,
    );
    lines.push(
      `  Final context:         ${fmtTokens(tokensList[tokensList.length - 1])}`,
    );
    const rates = a.growthBlocks
      .filter((b) => b.numEntries > 1 && b.ratePerTurn > 0)
      .map((b) => b.ratePerTurn);
    if (rates.length > 0) {
      const avg = rates.reduce((s, r) => s + r, 0) / rates.length;
      lines.push(
        `  Avg growth rate:       ${fmtTokens(Math.round(avg))}/turn (across ${rates.length} growth blocks)`,
      );
      lines.push(
        `  Max growth rate:       ${fmtTokens(Math.round(Math.max(...rates)))}/turn`,
      );
    }
  }
  if (a.compactions.length > 0) {
    const totalLost = a.compactions.reduce((s, c) => s + c.tokensLost, 0);
    lines.push(`  Total tokens compacted:${fmtTokens(totalLost)}`);
    const avgPct =
      a.compactions.reduce((s, c) => s + c.pctLost, 0) / a.compactions.length;
    lines.push(`  Avg compaction size:   ${avgPct.toFixed(1)}% of context`);
  }
  if (a.userTurns.length > 0) {
    const callsPerTurn = a.userTurns.map((t) => t.numApiCalls);
    const avg = callsPerTurn.reduce((s, c) => s + c, 0) / callsPerTurn.length;
    lines.push(`  Avg API calls/turn:    ${avg.toFixed(1)}`);
  }
  lines.push("");

  // Timing stats
  const t = a.timing;
  if (t.wallTimeMs > 0 || t.totalApiTimeMs > 0) {
    lines.push("TIMING");
    lines.push("-".repeat(70));
    if (t.wallTimeMs > 0) {
      lines.push(`  Wall time:             ${fmtDuration(t.wallTimeMs)}`);
    }
    if (t.totalApiTimeMs > 0) {
      lines.push(`  Total API time:        ${fmtDuration(t.totalApiTimeMs)}`);
      lines.push(`  Median API call:       ${fmtDuration(t.medianApiTimeMs)}`);
    }
    if (t.medianTokensPerSecond != null) {
      lines.push(
        `  Median tok/s (output): ${t.medianTokensPerSecond.toFixed(1)}`,
      );
    }
    if (t.totalInputTokens > 0 || t.totalOutputTokens > 0) {
      lines.push(`  Total input tokens:    ${fmtTokens(t.totalInputTokens)}`);
      lines.push(`  Total output tokens:   ${fmtTokens(t.totalOutputTokens)}`);
    }
    lines.push("");
  }

  // Cache stats
  const c = a.cache;
  if (c.totalCacheReadTokens > 0 || c.totalCacheWriteTokens > 0) {
    lines.push("CACHE");
    lines.push("-".repeat(70));
    lines.push(`  Cache read tokens:     ${fmtTokens(c.totalCacheReadTokens)}`);
    lines.push(
      `  Cache write tokens:    ${fmtTokens(c.totalCacheWriteTokens)}`,
    );
    lines.push(
      `  Cache hit rate:        ${(c.cacheHitRate * 100).toFixed(1)}%`,
    );
    lines.push("");
  }

  return lines.join("\n");
}
