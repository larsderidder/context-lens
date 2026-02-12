import type {
  CompositionEntry,
  ContextInfo,
  HealthRating,
  HealthScore,
  ParsedMessage,
  Tool,
} from "../types.js";

// ---------------------------------------------------------------------------
// Linear interpolation helper
// ---------------------------------------------------------------------------

/**
 * Given a sorted array of [threshold, score] breakpoints, linearly interpolate
 * a score for the given value. Values below the first breakpoint get its score;
 * values above the last get the last score.
 */
function lerp(value: number, breakpoints: [number, number][]): number {
  if (breakpoints.length === 0) return 100;
  if (value <= breakpoints[0][0]) return breakpoints[0][1];
  if (value >= breakpoints[breakpoints.length - 1][0])
    return breakpoints[breakpoints.length - 1][1];

  for (let i = 0; i < breakpoints.length - 1; i++) {
    const [x0, y0] = breakpoints[i];
    const [x1, y1] = breakpoints[i + 1];
    if (value >= x0 && value <= x1) {
      const t = (value - x0) / (x1 - x0);
      return Math.round(y0 + t * (y1 - y0));
    }
  }
  return breakpoints[breakpoints.length - 1][1];
}

function totalCompositionTokens(composition: CompositionEntry[]): number {
  return composition.reduce((s, c) => s + c.tokens, 0);
}

function compositionCategoryTokens(
  composition: CompositionEntry[],
  category: CompositionEntry["category"],
): number {
  return composition.find((c) => c.category === category)?.tokens ?? 0;
}

function compositionCategoryPct(
  composition: CompositionEntry[],
  category: CompositionEntry["category"],
): number {
  return Math.round(composition.find((c) => c.category === category)?.pct ?? 0);
}

function largestToolResultTokens(messages: ParsedMessage[]): number {
  let largest = 0;
  for (const m of messages) {
    if (!m.contentBlocks) continue;
    for (const b of m.contentBlocks) {
      if (b.type === "tool_result" && m.tokens > largest) {
        largest = m.tokens;
      }
    }
  }
  return largest;
}

function definedToolNames(tools: Tool[]): Set<string> {
  const names = new Set<string>();
  for (const t of tools) {
    const name =
      "name" in t
        ? t.name
        : "function" in t
          ? (t as { function: { name: string } }).function.name
          : null;
    if (name) names.add(name);
  }
  return names;
}

function countUsedDefinedTools(
  sessionToolsUsed: Set<string>,
  definedNames: Set<string>,
): number {
  let usedCount = 0;
  for (const name of sessionToolsUsed) {
    if (definedNames.has(name)) usedCount++;
  }
  return usedCount;
}

// ---------------------------------------------------------------------------
// Audit 1: Context Utilization (weight 30)
// ---------------------------------------------------------------------------

function scoreUtilization(totalTokens: number, contextLimit: number): number {
  if (contextLimit <= 0) return 100;
  const pct = (totalTokens / contextLimit) * 100;
  return lerp(pct, [
    [50, 100],
    [65, 90],
    [75, 70],
    [85, 45],
    [95, 20],
    [100, 5],
  ]);
}

function describeUtilization(
  totalTokens: number,
  contextLimit: number,
): string {
  if (contextLimit <= 0) return "No context limit known.";
  const pct = Math.round((totalTokens / contextLimit) * 100);
  if (pct <= 50) return `Context ${pct}% full — plenty of room.`;
  if (pct <= 75) return `Context ${pct}% full — moderate usage.`;
  if (pct <= 85)
    return `Context ${pct}% full — approaching limit, compaction risk.`;
  return `Context ${pct}% full — near overflow, compaction imminent.`;
}

// ---------------------------------------------------------------------------
// Audit 2: Tool Results Proportion (weight 25)
// ---------------------------------------------------------------------------

function scoreToolResults(
  composition: CompositionEntry[],
  messages: ParsedMessage[],
  utilizationPct: number,
): number {
  const totalTok = totalCompositionTokens(composition);
  if (totalTok === 0) return 100;

  const toolResultTokens = compositionCategoryTokens(
    composition,
    "tool_results",
  );
  const aggPct = (toolResultTokens / totalTok) * 100;

  const aggregateScore = lerp(aggPct, [
    [30, 100],
    [50, 80],
    [65, 60],
    [75, 35],
    [76, 15],
  ]);

  // Find largest single tool result message
  const largestResult = largestToolResultTokens(messages);

  const largestScore = lerp(largestResult, [
    [2000, 100],
    [5000, 80],
    [10000, 50],
    [10001, 20],
  ]);

  const rawScore = Math.min(aggregateScore, largestScore);

  // Context-dependent: tool results only matter when the window is filling up.
  // Scale the penalty by how full the context is.
  // At 0% util → full score (100), at 75%+ util → raw score, smooth blend between.
  const utilizationFactor = Math.min(Math.max(utilizationPct / 75, 0), 1);
  return Math.round(rawScore + (100 - rawScore) * (1 - utilizationFactor));
}

function describeToolResults(
  composition: CompositionEntry[],
  messages: ParsedMessage[],
  utilizationPct: number,
): string {
  const totalTok = totalCompositionTokens(composition);
  if (totalTok === 0) return "No context data.";

  const pct = compositionCategoryPct(composition, "tool_results");
  const largestResult = largestToolResultTokens(messages);

  const largestK =
    largestResult > 1000
      ? `${Math.round(largestResult / 1000)}K`
      : `${largestResult}`;
  const suffix =
    utilizationPct < 40
      ? " Plenty of room."
      : utilizationPct < 65
        ? " Monitor as context grows."
        : " Context is filling up.";

  if (pct <= 30 && largestResult <= 2000)
    return "Tool results are a small part of context.";
  if (pct > 60)
    return `Tool results are ${pct}% of context, largest ${largestK} tokens.${suffix}`;
  if (largestResult > 5000)
    return `Tool results are ${pct}% of context, largest ${largestK} tokens.${suffix}`;
  return `Tool results are ${pct}% of context.${suffix}`;
}

// ---------------------------------------------------------------------------
// Audit 3: Tool Definition Efficiency (weight 20)
// ---------------------------------------------------------------------------

function scoreToolEfficiency(
  composition: CompositionEntry[],
  tools: Tool[],
  sessionToolsUsed: Set<string>,
  turnCount: number,
): number {
  const totalTok = totalCompositionTokens(composition);
  if (totalTok === 0 || tools.length === 0) return 100;

  const toolDefTokens = compositionCategoryTokens(
    composition,
    "tool_definitions",
  );
  const overheadPct = (toolDefTokens / totalTok) * 100;

  const overheadScore = lerp(overheadPct, [
    [15, 100],
    [25, 80],
    [40, 50],
    [41, 20],
  ]);

  // Compute usage ratio
  const definedNames = definedToolNames(tools);
  const totalDefined = definedNames.size || 1;
  const usedCount = countUsedDefinedTools(sessionToolsUsed, definedNames);
  const usageRatio = (usedCount / totalDefined) * 100;

  let usageScore = lerp(usageRatio, [
    [0, 30],
    [10, 50],
    [30, 80],
    [50, 100],
  ]);

  // Early-turn floor: if turnCount ≤ 2, usage score ≥ 60
  if (turnCount <= 2 && usageScore < 60) {
    usageScore = 60;
  }

  return Math.round(0.6 * overheadScore + 0.4 * usageScore);
}

function describeToolEfficiency(
  composition: CompositionEntry[],
  tools: Tool[],
  sessionToolsUsed: Set<string>,
): string {
  const totalTok = totalCompositionTokens(composition);
  if (totalTok === 0 || tools.length === 0) return "No tool definitions.";

  const pct = compositionCategoryPct(composition, "tool_definitions");
  const definedNames = definedToolNames(tools);
  const usedCount = countUsedDefinedTools(sessionToolsUsed, definedNames);

  return `Tool definitions are ${pct}% of context. ${usedCount}/${definedNames.size} tools used in session.`;
}

// ---------------------------------------------------------------------------
// Audit 4: Context Growth Rate (weight 15)
// ---------------------------------------------------------------------------

function scoreGrowthRate(
  currentTokens: number,
  previousTokens: number | null,
  contextLimit: number,
): number {
  if (previousTokens === null) return 100; // first turn

  // Compaction detected
  if (currentTokens < previousTokens * 0.7) return 40;

  if (contextLimit <= 0) return 100;
  const growthPct = ((currentTokens - previousTokens) / contextLimit) * 100;
  return lerp(growthPct, [
    [5, 100],
    [10, 85],
    [20, 65],
    [30, 40],
    [31, 20],
  ]);
}

function describeGrowthRate(
  currentTokens: number,
  previousTokens: number | null,
  contextLimit: number,
): string {
  if (previousTokens === null) return "First turn — no growth data.";
  if (currentTokens < previousTokens * 0.7)
    return "Compaction detected — context was truncated or summarized.";
  if (contextLimit <= 0) return "Unknown context limit.";
  const growthPct = Math.round(
    ((currentTokens - previousTokens) / contextLimit) * 100,
  );
  if (growthPct <= 5) return `Grew ${growthPct}% of limit — steady.`;
  if (growthPct <= 20) return `Grew ${growthPct}% of limit — moderate pace.`;
  return `Grew ${growthPct}% of limit — rapid expansion.`;
}

// ---------------------------------------------------------------------------
// Audit 5: Thinking Overhead (weight 10)
// ---------------------------------------------------------------------------

function scoreThinking(composition: CompositionEntry[]): number {
  const totalTok = totalCompositionTokens(composition);
  if (totalTok === 0) return 100;

  const thinkingPct =
    (compositionCategoryTokens(composition, "thinking") / totalTok) * 100;

  return lerp(thinkingPct, [
    [5, 100],
    [10, 85],
    [20, 60],
    [30, 35],
    [31, 15],
  ]);
}

function describeThinking(composition: CompositionEntry[]): string {
  const totalTok = totalCompositionTokens(composition);
  if (totalTok === 0) return "No context data.";

  const pct = compositionCategoryPct(composition, "thinking");

  if (pct <= 5) return "Thinking blocks are minimal.";
  if (pct <= 15) return `Thinking blocks are ${pct}% of context.`;
  return `Thinking blocks are ${pct}% of context — significant hidden overhead.`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function ratingFromScore(score: number): HealthRating {
  if (score >= 90) return "good";
  if (score >= 50) return "needs-work";
  return "poor";
}

export function computeHealthScore(
  entry: {
    contextInfo: ContextInfo;
    contextLimit: number;
    composition: CompositionEntry[];
  },
  previousEntryTokens: number | null,
  sessionToolsUsed: Set<string>,
  turnCount: number,
): HealthScore {
  const { contextInfo, contextLimit, composition } = entry;
  const messages = contextInfo.messages || [];
  const tools = contextInfo.tools || [];

  const audits = [
    {
      id: "utilization",
      name: "Context Utilization",
      score: scoreUtilization(contextInfo.totalTokens, contextLimit),
      weight: 30,
      description: describeUtilization(contextInfo.totalTokens, contextLimit),
    },
    {
      id: "tool-results",
      name: "Tool Results",
      score: scoreToolResults(
        composition,
        messages,
        contextLimit > 0 ? (contextInfo.totalTokens / contextLimit) * 100 : 0,
      ),
      weight: 25,
      description: describeToolResults(
        composition,
        messages,
        contextLimit > 0 ? (contextInfo.totalTokens / contextLimit) * 100 : 0,
      ),
    },
    {
      id: "tool-defs",
      name: "Tool Definitions",
      score: scoreToolEfficiency(
        composition,
        tools,
        sessionToolsUsed,
        turnCount,
      ),
      weight: 20,
      description: describeToolEfficiency(composition, tools, sessionToolsUsed),
    },
    {
      id: "growth",
      name: "Growth Rate",
      score: scoreGrowthRate(
        contextInfo.totalTokens,
        previousEntryTokens,
        contextLimit,
      ),
      weight: 15,
      description: describeGrowthRate(
        contextInfo.totalTokens,
        previousEntryTokens,
        contextLimit,
      ),
    },
    {
      id: "thinking",
      name: "Thinking Overhead",
      score: scoreThinking(composition),
      weight: 10,
      description: describeThinking(composition),
    },
  ];

  const totalWeight = audits.reduce((s, a) => s + a.weight, 0);
  const overall = Math.round(
    audits.reduce((s, a) => s + a.score * a.weight, 0) / totalWeight,
  );

  return {
    overall,
    rating: ratingFromScore(overall),
    audits,
  };
}
