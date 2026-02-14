import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyzeSession,
  buildAgentPaths,
  findCompactions,
  findGrowthBlocks,
  fmtCost,
  fmtDuration,
  fmtTokens,
  formatSessionAnalysis,
  identifyUserTurns,
  shortModel,
} from "../src/core.js";
import { parseLharContent } from "../src/lhar.js";
import type {
  LharRecord,
  LharSessionLine,
} from "../src/lhar-types.generated.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkEntry(overrides: {
  sequence?: number;
  agentRole?: string;
  model?: string;
  finishReasons?: string[];
  cumulativeTokens?: number;
  compactionDetected?: boolean;
  costUsd?: number | null;
  composition?: Array<{
    category: string;
    tokens: number;
    pct: number;
    count: number;
  }>;
}): LharRecord {
  return {
    type: "entry",
    id: "test-id",
    trace_id: "test-trace",
    span_id: "test-span",
    parent_span_id: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    sequence: overrides.sequence ?? 1,
    source: {
      tool: "claude",
      tool_version: null,
      agent_role: overrides.agentRole ?? "main",
      collector: "context-lens",
      collector_version: "0.3.1",
    },
    gen_ai: {
      system: "anthropic",
      request: {
        model: overrides.model ?? "claude-sonnet-4-5-20250929",
        max_tokens: 8192,
        temperature: null,
        top_p: null,
        stop_sequences: [],
      },
      response: {
        model: overrides.model ?? "claude-sonnet-4-5-20250929",
        finish_reasons: overrides.finishReasons ?? ["end_turn"],
      },
      usage: {
        input_tokens: overrides.cumulativeTokens ?? 1000,
        output_tokens: 200,
        total_tokens: (overrides.cumulativeTokens ?? 1000) + 200,
      },
    },
    usage_ext: {
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: overrides.costUsd ?? 0.01,
    },
    http: {
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      status_code: 200,
      api_format: "anthropic-messages",
      stream: true,
      request_headers: {},
      response_headers: {},
    },
    timings: null,
    transfer: { request_bytes: 1000, response_bytes: 500, compressed: false },
    context_lens: {
      window_size: 200000,
      utilization: (overrides.cumulativeTokens ?? 1000) / 200000,
      system_tokens: 100,
      tools_tokens: 200,
      messages_tokens: (overrides.cumulativeTokens ?? 1000) - 300,
      composition: overrides.composition ?? [
        { category: "system_prompt", tokens: 100, pct: 10, count: 1 },
        { category: "tool_definitions", tokens: 200, pct: 20, count: 1 },
        { category: "user_text", tokens: 700, pct: 70, count: 1 },
      ],
      growth: {
        tokens_added_this_turn: null,
        cumulative_tokens: overrides.cumulativeTokens ?? 1000,
        compaction_detected: overrides.compactionDetected ?? false,
      },
      security: { alerts: [], summary: { high: 0, medium: 0, info: 0 } },
    },
    raw: { request_body: null, response_body: null },
  } as unknown as LharRecord;
}

// ---------------------------------------------------------------------------
// findCompactions
// ---------------------------------------------------------------------------

describe("findCompactions", () => {
  it("finds compaction events using the compaction_detected flag", () => {
    const entries = [
      mkEntry({ sequence: 1, cumulativeTokens: 10000 }),
      mkEntry({ sequence: 2, cumulativeTokens: 20000 }),
      mkEntry({
        sequence: 3,
        cumulativeTokens: 18000,
        compactionDetected: true,
      }),
    ];
    const compactions = findCompactions(entries);
    assert.equal(compactions.length, 1);
    assert.equal(compactions[0].entryIndex, 2);
    assert.equal(compactions[0].beforeTokens, 20000);
    assert.equal(compactions[0].afterTokens, 18000);
    assert.equal(compactions[0].tokensLost, 2000);
    assert.equal(compactions[0].pctLost, 10);
  });

  it("ignores entries without compaction_detected", () => {
    const entries = [
      mkEntry({ sequence: 1, cumulativeTokens: 10000 }),
      mkEntry({ sequence: 2, cumulativeTokens: 5000 }), // dropped but no flag
    ];
    const compactions = findCompactions(entries);
    assert.equal(compactions.length, 0);
  });

  it("handles interleaved agent roles correctly", () => {
    const entries = [
      mkEntry({ sequence: 1, agentRole: "main", cumulativeTokens: 50000 }),
      mkEntry({ sequence: 2, agentRole: "subagent", cumulativeTokens: 300 }),
      mkEntry({
        sequence: 3,
        agentRole: "main",
        cumulativeTokens: 48000,
        compactionDetected: true,
      }),
    ];
    const compactions = findCompactions(entries);
    assert.equal(compactions.length, 1);
    // Should match against the main entry at 50000, not the subagent at 300
    assert.equal(compactions[0].beforeTokens, 50000);
    assert.equal(compactions[0].afterTokens, 48000);
    assert.equal(compactions[0].tokensLost, 2000);
  });
});

// ---------------------------------------------------------------------------
// findGrowthBlocks
// ---------------------------------------------------------------------------

describe("findGrowthBlocks", () => {
  it("finds contiguous growth stretches between compactions", () => {
    const entries = [
      mkEntry({ sequence: 1, cumulativeTokens: 10000 }),
      mkEntry({ sequence: 2, cumulativeTokens: 20000 }),
      mkEntry({ sequence: 3, cumulativeTokens: 30000 }),
      mkEntry({
        sequence: 4,
        cumulativeTokens: 25000,
        compactionDetected: true,
      }),
      mkEntry({ sequence: 5, cumulativeTokens: 35000 }),
    ];
    const blocks = findGrowthBlocks(entries);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].numEntries, 3);
    assert.equal(blocks[0].tokensGained, 20000);
    assert.equal(blocks[1].numEntries, 2);
    assert.equal(blocks[1].tokensGained, 10000);
  });

  it("returns a single block when there are no compactions", () => {
    const entries = [
      mkEntry({ sequence: 1, cumulativeTokens: 10000 }),
      mkEntry({ sequence: 2, cumulativeTokens: 20000 }),
      mkEntry({ sequence: 3, cumulativeTokens: 30000 }),
    ];
    const blocks = findGrowthBlocks(entries);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].tokensGained, 20000);
  });
});

// ---------------------------------------------------------------------------
// identifyUserTurns
// ---------------------------------------------------------------------------

describe("identifyUserTurns", () => {
  it("groups entries into user turns based on end_turn + sequence jump", () => {
    const entries = [
      mkEntry({ sequence: 1, finishReasons: ["tool_use"] }),
      mkEntry({ sequence: 2, finishReasons: ["tool_use"] }),
      mkEntry({ sequence: 3, finishReasons: ["end_turn"] }),
      // New turn: sequence jumps
      mkEntry({ sequence: 5, finishReasons: ["tool_use"] }),
      mkEntry({ sequence: 6, finishReasons: ["end_turn"] }),
    ];
    const turns = identifyUserTurns(entries);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].numApiCalls, 3);
    assert.equal(turns[1].numApiCalls, 2);
  });

  it("handles a single entry as one turn", () => {
    const entries = [mkEntry({ sequence: 1 })];
    const turns = identifyUserTurns(entries);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].numApiCalls, 1);
  });

  it("returns empty for empty entries", () => {
    const turns = identifyUserTurns([]);
    assert.equal(turns.length, 0);
  });
});

// ---------------------------------------------------------------------------
// buildAgentPaths
// ---------------------------------------------------------------------------

describe("buildAgentPaths", () => {
  it("produces one path per user turn with correct actions", () => {
    const entries = [
      mkEntry({ sequence: 1, finishReasons: ["tool_use"] }),
      mkEntry({ sequence: 2, finishReasons: ["end_turn"] }),
      mkEntry({ sequence: 4, finishReasons: ["end_turn"] }),
    ];
    const turns = identifyUserTurns(entries);
    const paths = buildAgentPaths(entries, turns);
    assert.equal(paths.length, 2);
    assert.equal(paths[0][0].action, "tool_use");
    assert.equal(paths[0][1].action, "end_turn");
    assert.equal(paths[1][0].action, "end_turn");
  });

  it("marks compaction events", () => {
    const entries = [
      mkEntry({
        sequence: 1,
        cumulativeTokens: 50000,
        finishReasons: ["end_turn"],
      }),
      mkEntry({
        sequence: 3,
        cumulativeTokens: 48000,
        compactionDetected: true,
        finishReasons: ["end_turn"],
      }),
    ];
    const turns = identifyUserTurns(entries);
    const paths = buildAgentPaths(entries, turns);
    // Both entries are in the same turn (no prior end_turn processed before the second entry)
    assert.equal(paths.length, 1);
    assert.equal(paths[0][1].action, "compaction");
  });
});

// ---------------------------------------------------------------------------
// analyzeSession (integration)
// ---------------------------------------------------------------------------

describe("analyzeSession", () => {
  it("produces a complete analysis from entries", () => {
    const session: LharSessionLine = {
      type: "session",
      trace_id: "abc",
      started_at: "2026-01-01T00:00:00.000Z",
      tool: "claude",
      model: "claude-sonnet-4-5-20250929",
    };
    const entries = [
      mkEntry({
        sequence: 1,
        cumulativeTokens: 20000,
        finishReasons: ["tool_use"],
      }),
      mkEntry({
        sequence: 2,
        cumulativeTokens: 40000,
        finishReasons: ["end_turn"],
      }),
      mkEntry({
        sequence: 4,
        cumulativeTokens: 50000,
        finishReasons: ["end_turn"],
      }),
    ];
    const result = analyzeSession(session, entries, "test.lhar");

    assert.equal(result.filename, "test.lhar");
    assert.equal(result.tool, "claude");
    assert.equal(result.totalEntries, 3);
    assert.equal(result.userTurns.length, 2);
    assert.equal(result.compactions.length, 0);
    assert.equal(result.growthBlocks.length, 1);
    assert.ok(result.contextTimeline.length > 0);
    assert.ok(result.compositionLast.length > 0);
  });

  it("filters to main-only when option is set", () => {
    const entries = [
      mkEntry({ sequence: 1, agentRole: "main", cumulativeTokens: 20000 }),
      mkEntry({ sequence: 2, agentRole: "subagent", cumulativeTokens: 300 }),
      mkEntry({ sequence: 3, agentRole: "main", cumulativeTokens: 40000 }),
    ];
    const result = analyzeSession(null, entries, "test.lhar", {
      mainOnly: true,
    });
    // Context timeline should only have main entries
    assert.equal(result.contextTimeline.length, 2);
  });

  it("handles empty entries gracefully", () => {
    const result = analyzeSession(null, [], "empty.lhar");
    assert.equal(result.totalEntries, 0);
    assert.equal(result.userTurns.length, 0);
    assert.equal(result.compactions.length, 0);
  });
});

// ---------------------------------------------------------------------------
// formatSessionAnalysis
// ---------------------------------------------------------------------------

describe("formatSessionAnalysis", () => {
  it("produces non-empty output", () => {
    const entries = [
      mkEntry({
        sequence: 1,
        cumulativeTokens: 20000,
        finishReasons: ["end_turn"],
      }),
    ];
    const analysis = analyzeSession(null, entries, "test.lhar");
    const output = formatSessionAnalysis(analysis);
    assert.ok(output.includes("SESSION ANALYSIS"));
    assert.ok(output.includes("CONTEXT TIMELINE"));
    assert.ok(output.includes("SUMMARY STATISTICS"));
  });

  it("omits path trace when showPath is false", () => {
    const entries = [
      mkEntry({
        sequence: 1,
        cumulativeTokens: 20000,
        finishReasons: ["end_turn"],
      }),
    ];
    const analysis = analyzeSession(null, entries, "test.lhar");
    const output = formatSessionAnalysis(analysis, { showPath: false });
    assert.ok(!output.includes("AGENT PATH TRACE"));
  });

  it("shows pre-compaction composition", () => {
    const entries = [
      mkEntry({ sequence: 1, cumulativeTokens: 50000 }),
      mkEntry({
        sequence: 2,
        cumulativeTokens: 48000,
        compactionDetected: true,
      }),
    ];
    const analysis = analyzeSession(null, entries, "test.lhar");
    const output = formatSessionAnalysis(analysis, {
      composition: "pre-compaction",
    });
    assert.ok(output.includes("COMPOSITION BEFORE COMPACTIONS"));
  });
});

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

describe("formatting helpers", () => {
  it("fmtTokens formats numbers correctly", () => {
    assert.equal(fmtTokens(500), "500");
    assert.equal(fmtTokens(1500), "1.5K");
    assert.equal(fmtTokens(50000), "50.0K");
    assert.equal(fmtTokens(1500000), "1.5M");
  });

  it("fmtCost formats costs correctly", () => {
    assert.equal(fmtCost(null), "-");
    assert.equal(fmtCost(0), "-");
    assert.equal(fmtCost(0.005), "$0.0050");
    assert.equal(fmtCost(1.23), "$1.23");
  });

  it("shortModel shortens known model names", () => {
    assert.equal(shortModel("claude-sonnet-4-5-20250929"), "sonnet-4.5");
    assert.equal(shortModel("claude-haiku-4-5-20251001"), "haiku-4.5");
    assert.equal(shortModel("claude-opus-4-6"), "opus-4.6");
    assert.equal(shortModel("short"), "short");
  });

  it("fmtDuration formats durations correctly", () => {
    assert.equal(fmtDuration(500), "500ms");
    assert.equal(fmtDuration(1500), "1.5s");
    assert.equal(fmtDuration(45000), "45.0s");
    assert.equal(fmtDuration(90000), "1m 30s");
    assert.equal(fmtDuration(3661000), "1h 1m");
  });
});

// ---------------------------------------------------------------------------
// Timing and cache stats
// ---------------------------------------------------------------------------

describe("timing and cache stats", () => {
  it("computes wall time from first to last timestamp + last duration", () => {
    const e1 = mkEntry({ sequence: 1 });
    e1.timestamp = "2026-01-01T00:00:00.000Z";
    e1.timings = {
      send_ms: 10,
      wait_ms: 100,
      receive_ms: 200,
      total_ms: 5000,
      tokens_per_second: 50,
    };
    const e2 = mkEntry({ sequence: 2 });
    e2.timestamp = "2026-01-01T00:00:10.000Z";
    e2.timings = {
      send_ms: 10,
      wait_ms: 100,
      receive_ms: 200,
      total_ms: 3000,
      tokens_per_second: 80,
    };

    const result = analyzeSession(null, [e1, e2], "test.lhar");
    // Wall time = (10000 - 0) + 3000 = 13000ms
    assert.equal(result.timing.wallTimeMs, 13000);
    assert.equal(result.timing.totalApiTimeMs, 8000);
    assert.equal(result.timing.medianApiTimeMs, 5000); // sorted: [3000, 5000], median at floor(2/2)=idx 1
  });

  it("computes cache stats", () => {
    const e1 = mkEntry({ sequence: 1 });
    e1.usage_ext = {
      cache_read_tokens: 900,
      cache_write_tokens: 100,
      cost_usd: 0.01,
    };
    e1.gen_ai.usage = {
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
    };

    const result = analyzeSession(null, [e1], "test.lhar");
    assert.equal(result.cache.totalCacheReadTokens, 900);
    assert.equal(result.cache.totalCacheWriteTokens, 100);
    // hitRate = 900 / (100 + 900 + 100) = 900/1100 = 0.818
    assert.ok(Math.abs(result.cache.cacheHitRate - 0.818) < 0.01);
  });

  it("shows timing and cache sections in formatted output", () => {
    const e1 = mkEntry({ sequence: 1 });
    e1.timestamp = "2026-01-01T00:00:00.000Z";
    e1.timings = {
      send_ms: 10,
      wait_ms: 100,
      receive_ms: 200,
      total_ms: 5000,
      tokens_per_second: 50,
    };
    e1.usage_ext = {
      cache_read_tokens: 900,
      cache_write_tokens: 100,
      cost_usd: 0.01,
    };

    const result = analyzeSession(null, [e1], "test.lhar");
    const output = formatSessionAnalysis(result, { showPath: false });
    assert.ok(output.includes("TIMING"));
    assert.ok(output.includes("Wall time:"));
    assert.ok(output.includes("CACHE"));
    assert.ok(output.includes("Cache hit rate:"));
  });
});

// ---------------------------------------------------------------------------
// parseLharContent + analyzeSession integration
// ---------------------------------------------------------------------------

describe("parseLharContent + analyzeSession round-trip", () => {
  it("parses LHAR JSONL content and produces valid analysis", () => {
    const jsonl = [
      JSON.stringify({
        type: "session",
        trace_id: "abc123",
        started_at: "2026-01-01T00:00:00Z",
        tool: "claude",
        model: "claude-sonnet-4-5-20250929",
      }),
      JSON.stringify(
        mkEntry({
          sequence: 1,
          cumulativeTokens: 20000,
          finishReasons: ["tool_use"],
        }),
      ),
      JSON.stringify(
        mkEntry({
          sequence: 2,
          cumulativeTokens: 40000,
          finishReasons: ["end_turn"],
        }),
      ),
    ].join("\n");

    const { session, entries } = parseLharContent(jsonl);
    assert.ok(session);
    assert.equal(entries.length, 2);

    const analysis = analyzeSession(session, entries, "test.lhar");
    assert.equal(analysis.tool, "claude");
    assert.equal(analysis.totalEntries, 2);
    assert.equal(analysis.userTurns.length, 1);
  });
});
