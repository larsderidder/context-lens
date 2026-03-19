import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeWasteAnalysis } from "../src/core/waste.js";
import type { CompositionEntry, ProjectedEntry } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
  overrides: Partial<ProjectedEntry> & {
    composition?: CompositionEntry[];
    tools?: Array<{ name: string }>;
    calledTools?: string[];
    httpStatus?: number | null;
  } = {},
): ProjectedEntry {
  const {
    composition = [],
    tools = [],
    calledTools = [],
    httpStatus = 200,
    ...rest
  } = overrides;

  // Build messages with tool_use blocks for calledTools
  const messages = calledTools.map((name) => ({
    role: "assistant" as const,
    content: "",
    tokens: 10,
    contentBlocks: [{ type: "tool_use", id: "1", name }],
  }));

  return {
    id: 1,
    timestamp: "2024-01-01T00:00:00Z",
    contextInfo: {
      model: "claude-sonnet-4-20250514",
      messages,
      systemPrompts: [],
      tools,
      totalTokens: composition.reduce((s, c) => s + c.tokens, 0),
      systemTokens: 0,
      toolsTokens: 0,
      messagesTokens: 0,
    },
    response: {},
    contextLimit: 200_000,
    source: "claude",
    conversationId: "conv1",
    agentKey: null,
    agentLabel: "",
    httpStatus,
    timings: null,
    requestBytes: 0,
    responseBytes: 0,
    targetUrl: null,
    composition: composition as ProjectedEntry["composition"],
    costUsd: null,
    healthScore: null,
    securityAlerts: [],
    outputSecurityAlerts: [],
    usage: null,
    responseModel: null,
    stopReason: null,
    ...rest,
  } as unknown as ProjectedEntry;
}

function comp(items: Array<[string, number]>): CompositionEntry[] {
  const total = items.reduce((s, [, t]) => s + t, 0);
  return items.map(([category, tokens]) => ({
    category: category as CompositionEntry["category"],
    tokens,
    pct: total > 0 ? Math.round((tokens / total) * 100) : 0,
    count: 1,
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeWasteAnalysis", () => {
  it("returns empty analysis for empty entries", () => {
    const result = computeWasteAnalysis([]);
    assert.equal(result.totalInputTokens, 0);
    assert.equal(result.totalWasteTokens, 0);
    assert.equal(result.wasteRatio, 0);
    assert.deepEqual(result.categories, []);
    assert.equal(result.turnCount, 0);
  });

  it("excludes error (429) entries from analysis", () => {
    const goodEntry = makeEntry({ composition: comp([["user_text", 1000]]) });
    const badEntry = makeEntry({
      composition: comp([["user_text", 5000]]),
      httpStatus: 429,
    });
    const result = computeWasteAnalysis([goodEntry, badEntry]);
    assert.equal(result.turnCount, 1);
    assert.equal(result.totalInputTokens, 1000);
  });

  describe("unused_tools category", () => {
    it("counts tokens for tools never called in session", () => {
      const entries = [
        makeEntry({
          composition: comp([
            ["tool_definitions", 2000],
            ["user_text", 1000],
          ]),
          tools: [{ name: "Read" }, { name: "Write" }, { name: "Bash" }],
          calledTools: ["Read"], // only 1 of 3 called
        }),
        makeEntry({
          composition: comp([
            ["tool_definitions", 2000],
            ["user_text", 1200],
          ]),
          tools: [{ name: "Read" }, { name: "Write" }, { name: "Bash" }],
          calledTools: [], // session total: only Read was called
        }),
      ];

      const result = computeWasteAnalysis(entries);
      const cat = result.categories.find((c) => c.id === "unused_tools");
      assert.ok(cat, "unused_tools category should exist");

      // 2 unused out of 3 defined = 2/3 of tool_definitions tokens wasted per turn
      // Turn 0: 2/3 * 2000 = 1333
      // Turn 1: 2/3 * 2000 = 1333
      // Total: ~2666
      assert.ok(cat.tokens > 2000, `expected > 2000, got ${cat.tokens}`);
      assert.ok(cat.tokens < 3000, `expected < 3000, got ${cat.tokens}`);
      assert.deepEqual(result.unusedToolNames.sort(), ["Bash", "Write"]);
    });

    it("reports zero waste when all tools are called", () => {
      const entries = [
        makeEntry({
          composition: comp([
            ["tool_definitions", 1000],
            ["user_text", 500],
          ]),
          tools: [{ name: "Read" }],
          calledTools: ["Read"],
        }),
      ];
      const result = computeWasteAnalysis(entries);
      const cat = result.categories.find((c) => c.id === "unused_tools");
      assert.ok(!cat || cat.tokens === 0, "should have no unused tool waste");
    });

    it("reports zero waste when no tools are defined", () => {
      const entries = [
        makeEntry({
          composition: comp([["user_text", 1000]]),
          tools: [],
        }),
      ];
      const result = computeWasteAnalysis(entries);
      const cat = result.categories.find((c) => c.id === "unused_tools");
      assert.ok(!cat || cat.tokens === 0, "should have no unused tool waste");
    });
  });

  describe("oversized_results category", () => {
    it("counts tokens above the 8K threshold", () => {
      const entries = [
        makeEntry({
          composition: comp([
            ["tool_results", 20_000],
            ["user_text", 1000],
          ]),
        }),
      ];
      const result = computeWasteAnalysis(entries);
      const cat = result.categories.find((c) => c.id === "oversized_results");
      assert.ok(cat, "oversized_results category should exist");
      // 20000 - 8000 = 12000 tokens waste
      assert.equal(cat.tokens, 12_000);
    });

    it("does not flag results below the threshold", () => {
      const entries = [
        makeEntry({
          composition: comp([
            ["tool_results", 3_000],
            ["user_text", 1000],
          ]),
        }),
      ];
      const result = computeWasteAnalysis(entries);
      const cat = result.categories.find((c) => c.id === "oversized_results");
      assert.ok(
        !cat || cat.tokens === 0,
        "should have no oversized result waste",
      );
    });
  });

  describe("repeated_system category", () => {
    it("counts system prompt tokens on every turn after the first", () => {
      const entries = [
        makeEntry({
          composition: comp([
            ["system_prompt", 5000],
            ["user_text", 500],
          ]),
        }),
        makeEntry({
          composition: comp([
            ["system_prompt", 5000],
            ["user_text", 600],
          ]),
        }),
        makeEntry({
          composition: comp([
            ["system_prompt", 5000],
            ["user_text", 700],
          ]),
        }),
      ];
      const result = computeWasteAnalysis(entries);
      const cat = result.categories.find((c) => c.id === "repeated_system");
      assert.ok(cat, "repeated_system category should exist");
      // Turn 0: 0 (first turn is genuinely needed)
      // Turn 1: 5000
      // Turn 2: 5000
      // Total: 10000
      assert.equal(cat.tokens, 10_000);
    });

    it("includes system_injections in repeated system overhead", () => {
      const entries = [
        makeEntry({
          composition: comp([
            ["system_prompt", 3000],
            ["system_injections", 1000],
            ["user_text", 500],
          ]),
        }),
        makeEntry({
          composition: comp([
            ["system_prompt", 3000],
            ["system_injections", 1000],
            ["user_text", 500],
          ]),
        }),
      ];
      const result = computeWasteAnalysis(entries);
      const cat = result.categories.find((c) => c.id === "repeated_system");
      assert.ok(cat, "repeated_system category should exist");
      assert.equal(cat.tokens, 4_000); // 3000 + 1000 on turn 1 only
    });
  });

  describe("thinking_spill category", () => {
    it("counts thinking tokens above 40% of context", () => {
      // Total: 10000, thinking: 6000 (60%). Spill = 6000 - 4000 = 2000
      const entries = [
        makeEntry({
          composition: comp([
            ["thinking", 6000],
            ["user_text", 4000],
          ]),
        }),
      ];
      const result = computeWasteAnalysis(entries);
      const cat = result.categories.find((c) => c.id === "thinking_spill");
      assert.ok(cat, "thinking_spill category should exist");
      assert.equal(cat.tokens, 2_000);
    });

    it("does not flag thinking below the threshold", () => {
      // Total: 10000, thinking: 2000 (20%). No spill.
      const entries = [
        makeEntry({
          composition: comp([
            ["thinking", 2000],
            ["user_text", 8000],
          ]),
        }),
      ];
      const result = computeWasteAnalysis(entries);
      const cat = result.categories.find((c) => c.id === "thinking_spill");
      assert.ok(!cat || cat.tokens === 0, "should have no thinking spill");
    });
  });

  describe("compaction detection", () => {
    it("detects compaction when tokens drop by more than 30%", () => {
      const entries = [
        makeEntry({ composition: comp([["user_text", 50_000]]) }),
        makeEntry({ composition: comp([["user_text", 80_000]]) }),
        makeEntry({ composition: comp([["user_text", 20_000]]) }), // compaction
        makeEntry({ composition: comp([["user_text", 30_000]]) }),
      ];
      const result = computeWasteAnalysis(entries);
      assert.equal(result.compactionCount, 1);
    });

    it("does not flag gradual growth as compaction", () => {
      const entries = [
        makeEntry({ composition: comp([["user_text", 10_000]]) }),
        makeEntry({ composition: comp([["user_text", 20_000]]) }),
        makeEntry({ composition: comp([["user_text", 30_000]]) }),
      ];
      const result = computeWasteAnalysis(entries);
      assert.equal(result.compactionCount, 0);
    });
  });

  describe("aggregate metrics", () => {
    it("computes wasteRatio correctly", () => {
      // 3 turns, system prompt repeated on turns 1 and 2 only
      const entries = [
        makeEntry({
          composition: comp([
            ["system_prompt", 4000],
            ["user_text", 1000],
          ]),
        }),
        makeEntry({
          composition: comp([
            ["system_prompt", 4000],
            ["user_text", 1000],
          ]),
        }),
        makeEntry({
          composition: comp([
            ["system_prompt", 4000],
            ["user_text", 1000],
          ]),
        }),
      ];
      const result = computeWasteAnalysis(entries);
      // Total input = 3 * 5000 = 15000
      // Waste = 2 * 4000 = 8000 (system_prompt on turns 1 and 2)
      assert.equal(result.totalInputTokens, 15_000);
      assert.equal(result.totalWasteTokens, 8_000);
      assert.ok(Math.abs(result.wasteRatio - 8000 / 15000) < 0.01);
    });

    it("accumulates waste across multiple categories", () => {
      const entries = [
        makeEntry({
          composition: comp([
            ["system_prompt", 2000],
            ["tool_definitions", 3000],
            ["tool_results", 15_000], // oversized: 15000 - 8000 = 7000 waste
            ["user_text", 500],
          ]),
          tools: [{ name: "Read" }, { name: "Never" }],
          calledTools: ["Read"],
        }),
      ];
      const result = computeWasteAnalysis(entries);
      // Oversized: 7000, Unused tools: 1/2 * 3000 = 1500
      // Repeated system: 0 (first turn)
      const oversized = result.categories.find(
        (c) => c.id === "oversized_results",
      );
      const unused = result.categories.find((c) => c.id === "unused_tools");
      assert.equal(oversized?.tokens, 7_000);
      assert.equal(unused?.tokens, 1_500);
    });
  });
});
