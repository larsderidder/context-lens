/**
 * Session analysis: computes detailed statistics from LHAR entry records.
 *
 * Pure functions only (no I/O). Accepts parsed LharRecord arrays and
 * returns structured analysis results.
 */

import type {
  CompositionEntry,
  LharRecord,
  LharSessionLine,
} from "../lhar-types.generated.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface CompactionEvent {
  /** Index into the entries array */
  entryIndex: number;
  sequence: number;
  beforeTokens: number;
  afterTokens: number;
  tokensLost: number;
  pctLost: number;
}

export interface GrowthBlock {
  startIndex: number;
  endIndex: number;
  startTokens: number;
  endTokens: number;
  numEntries: number;
  tokensGained: number;
  /** Average tokens added per entry in this block */
  ratePerTurn: number;
}

export interface UserTurn {
  turnNumber: number;
  startEntryIndex: number;
  endEntryIndex: number;
  numApiCalls: number;
  modelsUsed: string[];
  totalCost: number;
  peakContextTokens: number;
  compactionsInTurn: number;
}

export interface AgentPathStep {
  entryIndex: number;
  sequence: number;
  agentRole: string;
  model: string;
  /** "tool_use", "end_turn", "compaction", "no_response", or raw finish reason */
  action: string;
  contextTokens: number;
  costUsd: number | null;
}

export interface CacheStats {
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  /** Fraction of input tokens served from cache (0..1) */
  cacheHitRate: number;
}

export interface TimingStats {
  /** Wall clock time from first to last entry timestamp (ms) */
  wallTimeMs: number;
  /** Sum of all API call durations (ms) */
  totalApiTimeMs: number;
  /** Median API call duration (ms) */
  medianApiTimeMs: number;
  /** Median output tokens per second */
  medianTokensPerSecond: number | null;
  /** Total output tokens across all entries */
  totalOutputTokens: number;
  /** Total input tokens across all entries */
  totalInputTokens: number;
}

export interface SessionAnalysis {
  filename: string;
  tool: string;
  primaryModel: string;
  startedAt: string;

  totalEntries: number;
  mainEntries: number;
  subagentEntries: number;

  userTurns: UserTurn[];
  /** (entryIndex, cumulativeTokens) pairs for main agent entries */
  contextTimeline: Array<[number, number]>;
  growthBlocks: GrowthBlock[];
  compactions: CompactionEvent[];
  totalCostUsd: number;
  compositionLast: CompositionEntry[];
  /** (entryIndex, composition) pairs for entries right before each compaction */
  compositionsPreCompaction: Array<[number, CompositionEntry[]]>;
  /** One path (list of steps) per user turn */
  agentPaths: AgentPathStep[][];
  /** Wall time and API call timing stats */
  timing: TimingStats;
  /** Prompt cache usage stats */
  cache: CacheStats;
}

// ---------------------------------------------------------------------------
// Internal helpers: entry accessors
// ---------------------------------------------------------------------------

function agentRole(e: LharRecord): string {
  return e.source.agent_role || "";
}

function cumTokens(e: LharRecord): number {
  return e.context_lens.growth.cumulative_tokens;
}

function isCompaction(e: LharRecord): boolean {
  return e.context_lens.growth.compaction_detected;
}

function finishReasons(e: LharRecord): string[] {
  return e.gen_ai.response.finish_reasons;
}

function costUsd(e: LharRecord): number | null {
  return e.usage_ext.cost_usd;
}

function model(e: LharRecord): string {
  return e.gen_ai.request.model;
}

// ---------------------------------------------------------------------------
// Compaction detection
// ---------------------------------------------------------------------------

export function findCompactions(entries: LharRecord[]): CompactionEvent[] {
  const compactions: CompactionEvent[] = [];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!isCompaction(e)) continue;

    // Find the best preceding entry: same agent_role, with a larger
    // cumulative token count (the state right before compaction shrunk it).
    let bestBefore: number | null = null;
    const role = agentRole(e);
    const after = cumTokens(e);

    for (let j = i - 1; j >= 0; j--) {
      const prev = entries[j];
      if (agentRole(prev) !== role) continue;
      if (cumTokens(prev) >= after) {
        bestBefore = cumTokens(prev);
        break;
      }
    }

    if (bestBefore === null || bestBefore === 0) {
      compactions.push({
        entryIndex: i,
        sequence: e.sequence,
        beforeTokens: 0,
        afterTokens: after,
        tokensLost: 0,
        pctLost: 0,
      });
      continue;
    }

    const lost = bestBefore - after;
    compactions.push({
      entryIndex: i,
      sequence: e.sequence,
      beforeTokens: bestBefore,
      afterTokens: after,
      tokensLost: lost,
      pctLost: bestBefore > 0 ? Math.round((lost / bestBefore) * 1000) / 10 : 0,
    });
  }

  return compactions;
}

// ---------------------------------------------------------------------------
// Growth blocks
// ---------------------------------------------------------------------------

export function findGrowthBlocks(entries: LharRecord[]): GrowthBlock[] {
  // Use main agent entries; fall back to all if no main role detected
  let main = entries.filter((e) => agentRole(e) === "main");
  if (main.length === 0) main = entries;
  if (main.length === 0) return [];

  // Map from main-filtered index back to entries[] index
  const mainIndices = entries
    .map((e, i) => (agentRole(e) === "main" ? i : -1))
    .filter((i) => i >= 0);
  if (mainIndices.length === 0) {
    // fallback: all entries
    return findGrowthBlocksFromSlice(entries, entries.map((_, i) => i));
  }
  return findGrowthBlocksFromSlice(main, mainIndices);
}

function findGrowthBlocksFromSlice(
  slice: LharRecord[],
  originalIndices: number[],
): GrowthBlock[] {
  const blocks: GrowthBlock[] = [];
  let blockStart = 0;

  for (let i = 0; i < slice.length; i++) {
    if (isCompaction(slice[i]) && i > blockStart) {
      const prev = slice[i - 1];
      const startE = slice[blockStart];
      const num = i - blockStart;
      const gained = cumTokens(prev) - cumTokens(startE);
      blocks.push({
        startIndex: originalIndices[blockStart],
        endIndex: originalIndices[i - 1],
        startTokens: cumTokens(startE),
        endTokens: cumTokens(prev),
        numEntries: num,
        tokensGained: gained,
        ratePerTurn: num > 0 ? Math.round((gained / num) * 10) / 10 : 0,
      });
      blockStart = i;
    }
  }

  // Final block
  if (blockStart < slice.length) {
    const startE = slice[blockStart];
    const endE = slice[slice.length - 1];
    const num = slice.length - blockStart;
    const gained = cumTokens(endE) - cumTokens(startE);
    blocks.push({
      startIndex: originalIndices[blockStart],
      endIndex: originalIndices[slice.length - 1],
      startTokens: cumTokens(startE),
      endTokens: cumTokens(endE),
      numEntries: num,
      tokensGained: gained,
      ratePerTurn: num > 0 ? Math.round((gained / num) * 10) / 10 : 0,
    });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// User turns
// ---------------------------------------------------------------------------

export function identifyUserTurns(entries: LharRecord[]): UserTurn[] {
  if (entries.length === 0) return [];

  const turns: UserTurn[] = [];
  let currentStart = 0;
  let turnNumber = 1;
  let lastMainEndTurnIdx: number | null = null;

  for (let i = 1; i < entries.length; i++) {
    const e = entries[i];
    let isNewTurn = false;

    if (agentRole(e) === "main" && lastMainEndTurnIdx !== null) {
      const prevMain = entries[lastMainEndTurnIdx];
      if (e.sequence > prevMain.sequence) {
        isNewTurn = true;
      }
    }

    if (isNewTurn) {
      turns.push(
        buildUserTurn(turnNumber, currentStart, i - 1, entries.slice(currentStart, i)),
      );
      turnNumber++;
      currentStart = i;
      lastMainEndTurnIdx = null;
    }

    if (agentRole(e) === "main" && finishReasons(e).includes("end_turn")) {
      lastMainEndTurnIdx = i;
    }
  }

  // Final turn
  turns.push(
    buildUserTurn(
      turnNumber,
      currentStart,
      entries.length - 1,
      entries.slice(currentStart),
    ),
  );

  return turns;
}

function buildUserTurn(
  turnNumber: number,
  start: number,
  end: number,
  turnEntries: LharRecord[],
): UserTurn {
  const models = new Set<string>();
  let cost = 0;
  let peak = 0;
  let compactions = 0;

  for (const e of turnEntries) {
    models.add(model(e));
    const c = costUsd(e);
    if (c) cost += c;
    const ct = cumTokens(e);
    if (ct > peak) peak = ct;
    if (isCompaction(e)) compactions++;
  }

  return {
    turnNumber,
    startEntryIndex: start,
    endEntryIndex: end,
    numApiCalls: turnEntries.length,
    modelsUsed: [...models].sort(),
    totalCost: Math.round(cost * 1_000_000) / 1_000_000,
    peakContextTokens: peak,
    compactionsInTurn: compactions,
  };
}

// ---------------------------------------------------------------------------
// Agent path trace
// ---------------------------------------------------------------------------

export function buildAgentPaths(
  entries: LharRecord[],
  userTurns: UserTurn[],
): AgentPathStep[][] {
  return userTurns.map((turn) => {
    const turnEntries = entries.slice(
      turn.startEntryIndex,
      turn.endEntryIndex + 1,
    );
    return turnEntries.map((e, i) => {
      let action: string;
      if (isCompaction(e)) {
        action = "compaction";
      } else if (finishReasons(e).includes("tool_use")) {
        action = "tool_use";
      } else if (finishReasons(e).includes("end_turn")) {
        action = "end_turn";
      } else if (finishReasons(e).length === 0) {
        action = "no_response";
      } else {
        action = finishReasons(e).join(", ");
      }

      return {
        entryIndex: turn.startEntryIndex + i,
        sequence: e.sequence,
        agentRole: agentRole(e),
        model: model(e),
        action,
        contextTokens: cumTokens(e),
        costUsd: costUsd(e),
      };
    });
  });
}

// ---------------------------------------------------------------------------
// Timing & cache stats
// ---------------------------------------------------------------------------

function computeTimingStats(entries: LharRecord[]): TimingStats {
  if (entries.length === 0) {
    return {
      wallTimeMs: 0,
      totalApiTimeMs: 0,
      medianApiTimeMs: 0,
      medianTokensPerSecond: null,
      totalOutputTokens: 0,
      totalInputTokens: 0,
    };
  }

  // Wall time: first timestamp to last timestamp
  const timestamps = entries.map((e) => new Date(e.timestamp).getTime());
  const firstTs = Math.min(...timestamps);
  const lastTs = Math.max(...timestamps);
  // Add the duration of the last entry to get true wall time
  const lastEntry = entries[entries.length - 1];
  const lastDuration = lastEntry.timings?.total_ms ?? 0;
  const wallTimeMs = lastTs - firstTs + lastDuration;

  // API call durations
  const durations: number[] = [];
  let totalApiTimeMs = 0;
  for (const e of entries) {
    if (e.timings && e.timings.total_ms > 0) {
      durations.push(e.timings.total_ms);
      totalApiTimeMs += e.timings.total_ms;
    }
  }

  // Median duration
  durations.sort((a, b) => a - b);
  const medianApiTimeMs =
    durations.length > 0
      ? durations[Math.floor(durations.length / 2)]
      : 0;

  // Tokens per second
  const tpsList: number[] = [];
  for (const e of entries) {
    if (e.timings?.tokens_per_second != null && e.timings.tokens_per_second > 0) {
      tpsList.push(e.timings.tokens_per_second);
    }
  }
  tpsList.sort((a, b) => a - b);
  const medianTokensPerSecond =
    tpsList.length > 0
      ? tpsList[Math.floor(tpsList.length / 2)]
      : null;

  // Total I/O tokens
  let totalOutputTokens = 0;
  let totalInputTokens = 0;
  for (const e of entries) {
    totalOutputTokens += e.gen_ai.usage.output_tokens;
    totalInputTokens += e.gen_ai.usage.input_tokens;
  }

  return {
    wallTimeMs,
    totalApiTimeMs,
    medianApiTimeMs,
    medianTokensPerSecond,
    totalOutputTokens,
    totalInputTokens,
  };
}

function computeCacheStats(entries: LharRecord[]): CacheStats {
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalInputTokens = 0;

  for (const e of entries) {
    totalCacheReadTokens += e.usage_ext.cache_read_tokens;
    totalCacheWriteTokens += e.usage_ext.cache_write_tokens;
    // Effective input = base input + cache read + cache write
    totalInputTokens +=
      e.gen_ai.usage.input_tokens +
      e.usage_ext.cache_read_tokens +
      e.usage_ext.cache_write_tokens;
  }

  const cacheHitRate =
    totalInputTokens > 0
      ? Math.round((totalCacheReadTokens / totalInputTokens) * 1000) / 1000
      : 0;

  return { totalCacheReadTokens, totalCacheWriteTokens, cacheHitRate };
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

export interface AnalyzeOptions {
  /** Only include main agent entries (skip subagent) */
  mainOnly?: boolean;
}

export function analyzeSession(
  session: LharSessionLine | null,
  allEntries: LharRecord[],
  filename: string,
  opts: AnalyzeOptions = {},
): SessionAnalysis {
  const entries = opts.mainOnly
    ? allEntries.filter((e) => agentRole(e) === "main")
    : allEntries;

  if (entries.length === 0) {
    return emptyAnalysis(filename, session);
  }

  // Primary model: most common model among main agent entries
  const modelCounts = new Map<string, number>();
  for (const e of allEntries) {
    if (agentRole(e) === "main") {
      const m = model(e);
      modelCounts.set(m, (modelCounts.get(m) || 0) + 1);
    }
  }
  let primaryModel = session?.model || "";
  if (modelCounts.size > 0) {
    let maxCount = 0;
    for (const [m, count] of modelCounts) {
      if (count > maxCount) {
        primaryModel = m;
        maxCount = count;
      }
    }
  }
  if (!primaryModel) {
    primaryModel = model(entries[0]);
  }

  const tool = session?.tool || entries[0].source.tool || "";
  const startedAt = session?.started_at || entries[0].timestamp;

  const mainCount = allEntries.filter((e) => agentRole(e) === "main").length;
  const subagentCount = allEntries.filter(
    (e) => agentRole(e) === "subagent",
  ).length;

  // Context timeline: main agent only
  let timelineEntries = entries.filter((e) => agentRole(e) === "main");
  if (timelineEntries.length === 0) timelineEntries = entries;
  const contextTimeline: Array<[number, number]> = timelineEntries.map(
    (e) => {
      const idx = entries.indexOf(e);
      return [idx, cumTokens(e)];
    },
  );

  // Compaction events
  const compactions = findCompactions(entries);

  // Growth blocks
  const growthBlocks = findGrowthBlocks(entries);

  // User turns
  const userTurns = identifyUserTurns(entries);

  // Total cost (across all entries, including subagent)
  let totalCost = 0;
  for (const e of allEntries) {
    const c = costUsd(e);
    if (c) totalCost += c;
  }

  // Composition: last main agent entry
  let lastMain = entries.filter((e) => agentRole(e) === "main");
  if (lastMain.length === 0) lastMain = entries;
  const compositionLast =
    lastMain[lastMain.length - 1].context_lens.composition;

  // Composition: entry right before each compaction (same agent role)
  const compositionsPreCompaction: Array<[number, CompositionEntry[]]> = [];
  for (const comp of compactions) {
    const compactedEntry = entries[comp.entryIndex];
    const role = agentRole(compactedEntry);
    for (let j = comp.entryIndex - 1; j >= 0; j--) {
      const prev = entries[j];
      if (agentRole(prev) === role && cumTokens(prev) >= cumTokens(compactedEntry)) {
        compositionsPreCompaction.push([j, prev.context_lens.composition]);
        break;
      }
    }
  }

  // Agent paths
  const agentPaths = buildAgentPaths(entries, userTurns);

  // Timing and cache stats (computed across all entries, not filtered)
  const timing = computeTimingStats(allEntries);
  const cache = computeCacheStats(allEntries);

  return {
    filename,
    tool,
    primaryModel,
    startedAt,
    totalEntries: allEntries.length,
    mainEntries: mainCount,
    subagentEntries: subagentCount,
    userTurns,
    contextTimeline,
    growthBlocks,
    compactions,
    totalCostUsd: Math.round(totalCost * 10_000) / 10_000,
    compositionLast,
    compositionsPreCompaction,
    agentPaths,
    timing,
    cache,
  };
}

function emptyAnalysis(
  filename: string,
  session: LharSessionLine | null,
): SessionAnalysis {
  return {
    filename,
    tool: session?.tool || "",
    primaryModel: session?.model || "unknown",
    startedAt: session?.started_at || "",
    totalEntries: 0,
    mainEntries: 0,
    subagentEntries: 0,
    userTurns: [],
    contextTimeline: [],
    growthBlocks: [],
    compactions: [],
    totalCostUsd: 0,
    compositionLast: [],
    compositionsPreCompaction: [],
    agentPaths: [],
    timing: {
      wallTimeMs: 0,
      totalApiTimeMs: 0,
      medianApiTimeMs: 0,
      medianTokensPerSecond: null,
      totalOutputTokens: 0,
      totalInputTokens: 0,
    },
    cache: {
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      cacheHitRate: 0,
    },
  };
}
