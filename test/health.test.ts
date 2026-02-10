import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeHealthScore } from "../src/core.js";
import type {
  CompositionEntry,
  ContextInfo,
  ParsedMessage,
  Tool,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkComposition(
  overrides: Partial<Record<string, { tokens: number; count: number }>>,
  totalTokens?: number,
): CompositionEntry[] {
  const entries: CompositionEntry[] = [];
  let sum = 0;
  for (const [cat, val] of Object.entries(overrides)) {
    if (val) {
      entries.push({
        category: cat as CompositionEntry["category"],
        tokens: val.tokens,
        pct: 0,
        count: val.count,
      });
      sum += val.tokens;
    }
  }
  const total = totalTokens ?? sum;
  for (const e of entries) {
    e.pct = total > 0 ? Math.round((e.tokens / total) * 1000) / 10 : 0;
  }
  return entries;
}

function mkMessages(msgs: Partial<ParsedMessage>[]): ParsedMessage[] {
  return msgs.map((m) => ({
    role: m.role ?? "user",
    content: m.content ?? "",
    tokens: m.tokens ?? 0,
    contentBlocks: m.contentBlocks ?? null,
  }));
}

function mkTools(count: number): Tool[] {
  const tools: Tool[] = [];
  for (let i = 0; i < count; i++) {
    tools.push({ name: `tool_${i}`, description: `Tool ${i}` });
  }
  return tools;
}

function mkEntry(opts: {
  totalTokens: number;
  contextLimit: number;
  composition: CompositionEntry[];
  messages?: ParsedMessage[];
  tools?: Tool[];
}) {
  return {
    contextInfo: {
      provider: "anthropic" as const,
      apiFormat: "anthropic-messages" as const,
      model: "claude-sonnet-4",
      systemTokens: 0,
      toolsTokens: 0,
      messagesTokens: opts.totalTokens,
      totalTokens: opts.totalTokens,
      systemPrompts: [],
      tools: opts.tools ?? [],
      messages: opts.messages ?? [],
    } satisfies ContextInfo,
    contextLimit: opts.contextLimit,
    composition: opts.composition,
  };
}

function findAudit(
  result: ReturnType<typeof computeHealthScore>,
  id: string,
): (typeof result.audits)[0] {
  const audit = result.audits.find((a) => a.id === id);
  if (!audit) throw new Error(`Audit '${id}' not found`);
  return audit;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeHealthScore", () => {
  it("healthy early turn → overall ≥ 90", () => {
    const entry = mkEntry({
      totalTokens: 5000,
      contextLimit: 200000,
      composition: mkComposition({
        system_prompt: { tokens: 2000, count: 1 },
        user_text: { tokens: 1000, count: 2 },
        assistant_text: { tokens: 1500, count: 2 },
        tool_results: { tokens: 500, count: 1 },
      }),
      messages: mkMessages([{ role: "user", tokens: 500 }]),
    });
    const result = computeHealthScore(entry, null, new Set(), 1);
    assert.ok(
      result.overall >= 90,
      `Expected overall ≥ 90, got ${result.overall}`,
    );
    assert.equal(result.rating, "good");
  });

  it("critical utilization (90%) → utilization audit < 30, overall < 50", () => {
    const total = 180000;
    const entry = mkEntry({
      totalTokens: total,
      contextLimit: 200000,
      composition: mkComposition({
        tool_results: { tokens: 140000, count: 20 },
        system_prompt: { tokens: 20000, count: 1 },
        user_text: { tokens: 10000, count: 5 },
        assistant_text: { tokens: 10000, count: 5 },
      }),
      messages: mkMessages([
        {
          role: "user",
          tokens: 8000,
          contentBlocks: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "x".repeat(200),
            },
          ],
        },
      ]),
    });
    const result = computeHealthScore(entry, 160000, new Set(), 10);
    const util = findAudit(result, "utilization");
    assert.ok(util.score < 35, `Expected utilization < 35, got ${util.score}`);
    assert.ok(
      result.overall < 60,
      `Expected overall < 60, got ${result.overall}`,
    );
  });

  it("tool definitions at 43% → tool-defs audit < 50", () => {
    // 43% tool defs with 0 tools used
    const entry = mkEntry({
      totalTokens: 33000,
      contextLimit: 200000,
      composition: mkComposition({
        tool_definitions: { tokens: 14190, count: 14 },
        system_prompt: { tokens: 4000, count: 1 },
        user_text: { tokens: 7000, count: 5 },
        assistant_text: { tokens: 7810, count: 5 },
      }),
      tools: mkTools(14),
    });
    const result = computeHealthScore(entry, null, new Set(), 5);
    const toolDefs = findAudit(result, "tool-defs");
    assert.ok(
      toolDefs.score < 50,
      `Expected tool-defs < 50, got ${toolDefs.score}`,
    );
  });

  it("tool results at 75% with high utilization → tool-results audit < 40", () => {
    // 150K total / 200K limit = 75% utilization — tool results matter here
    const total = 150000;
    const entry = mkEntry({
      totalTokens: total,
      contextLimit: 200000,
      composition: mkComposition({
        tool_results: { tokens: 112500, count: 30 },
        system_prompt: { tokens: 10000, count: 1 },
        user_text: { tokens: 12500, count: 10 },
        assistant_text: { tokens: 15000, count: 10 },
      }),
      messages: mkMessages([
        {
          role: "user",
          tokens: 20000,
          contentBlocks: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "x".repeat(200),
            },
          ],
        },
      ]),
    });
    const result = computeHealthScore(entry, null, new Set(), 5);
    const toolResults = findAudit(result, "tool-results");
    assert.ok(
      toolResults.score < 40,
      `Expected tool-results < 40, got ${toolResults.score}`,
    );
  });

  it("tool results at 75% with low utilization → tool-results audit ≥ 70", () => {
    // 40K total / 200K limit = 20% utilization — plenty of room, don't penalize
    const total = 40000;
    const entry = mkEntry({
      totalTokens: total,
      contextLimit: 200000,
      composition: mkComposition({
        tool_results: { tokens: 30000, count: 10 },
        system_prompt: { tokens: 4000, count: 1 },
        user_text: { tokens: 3000, count: 5 },
        assistant_text: { tokens: 3000, count: 5 },
      }),
      messages: mkMessages([
        {
          role: "user",
          tokens: 12000,
          contentBlocks: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "x".repeat(200),
            },
          ],
        },
      ]),
    });
    const result = computeHealthScore(entry, null, new Set(), 5);
    const toolResults = findAudit(result, "tool-results");
    assert.ok(
      toolResults.score >= 70,
      `Expected tool-results ≥ 70 at low util, got ${toolResults.score}`,
    );
  });

  it("thinking at 25% → thinking audit < 40", () => {
    const total = 40000;
    const entry = mkEntry({
      totalTokens: total,
      contextLimit: 200000,
      composition: mkComposition({
        thinking: { tokens: 10000, count: 5 },
        system_prompt: { tokens: 4000, count: 1 },
        user_text: { tokens: 13000, count: 10 },
        assistant_text: { tokens: 13000, count: 10 },
      }),
    });
    const result = computeHealthScore(entry, null, new Set(), 5);
    const thinking = findAudit(result, "thinking");
    assert.ok(
      thinking.score < 50,
      `Expected thinking < 50, got ${thinking.score}`,
    );
  });

  it("compaction detected → growth audit = 40", () => {
    const entry = mkEntry({
      totalTokens: 50000,
      contextLimit: 200000,
      composition: mkComposition({
        system_prompt: { tokens: 4000, count: 1 },
        user_text: { tokens: 23000, count: 10 },
        assistant_text: { tokens: 23000, count: 10 },
      }),
    });
    // Previous was 100000 → current 50000 is 50% of previous (< 70%)
    const result = computeHealthScore(entry, 100000, new Set(), 5);
    const growth = findAudit(result, "growth");
    assert.equal(growth.score, 40);
  });

  it("rapid growth (25% of limit) → growth audit < 50", () => {
    const entry = mkEntry({
      totalTokens: 100000,
      contextLimit: 200000,
      composition: mkComposition({
        system_prompt: { tokens: 4000, count: 1 },
        user_text: { tokens: 48000, count: 10 },
        assistant_text: { tokens: 48000, count: 10 },
      }),
    });
    // Previous was 50000 → growth is 50000/200000 = 25%
    const result = computeHealthScore(entry, 50000, new Set(), 5);
    const growth = findAudit(result, "growth");
    assert.ok(growth.score < 55, `Expected growth < 55, got ${growth.score}`);
  });

  it("all healthy → overall ≥ 85", () => {
    const entry = mkEntry({
      totalTokens: 20000,
      contextLimit: 200000,
      composition: mkComposition({
        system_prompt: { tokens: 4000, count: 1 },
        tool_definitions: { tokens: 2000, count: 5 },
        tool_results: { tokens: 4000, count: 3 },
        user_text: { tokens: 5000, count: 5 },
        assistant_text: { tokens: 4500, count: 5 },
        thinking: { tokens: 500, count: 2 },
      }),
      messages: mkMessages([
        {
          role: "user",
          tokens: 1500,
          contentBlocks: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "small result",
            },
          ],
        },
      ]),
      tools: mkTools(5),
    });
    const usedTools = new Set(["tool_0", "tool_1", "tool_2"]);
    const result = computeHealthScore(entry, 18000, usedTools, 3);
    assert.ok(
      result.overall >= 85,
      `Expected overall ≥ 85, got ${result.overall}`,
    );
  });

  it("first turn (null previous) → growth audit = 100", () => {
    const entry = mkEntry({
      totalTokens: 10000,
      contextLimit: 200000,
      composition: mkComposition({
        system_prompt: { tokens: 4000, count: 1 },
        user_text: { tokens: 3000, count: 1 },
        assistant_text: { tokens: 3000, count: 1 },
      }),
    });
    const result = computeHealthScore(entry, null, new Set(), 1);
    const growth = findAudit(result, "growth");
    assert.equal(growth.score, 100);
  });

  it("empty composition → sensible defaults, no crash", () => {
    const entry = mkEntry({
      totalTokens: 0,
      contextLimit: 200000,
      composition: [],
    });
    const result = computeHealthScore(entry, null, new Set(), 0);
    assert.ok(result.overall >= 0 && result.overall <= 100);
    assert.equal(result.audits.length, 5);
    assert.ok(["good", "needs-work", "poor"].includes(result.rating));
  });

  it("weighted average correctness → manual calculation matches", () => {
    // Build an entry where we can predict each audit score.
    // Utilization: 10K/200K = 5% → 100 (well below 50%)
    // Tool results: 0% → 100
    // Tool defs: no tools → 100
    // Growth: null (first turn) → 100
    // Thinking: 0% → 100
    // All 100 → weighted average = 100
    const entry = mkEntry({
      totalTokens: 10000,
      contextLimit: 200000,
      composition: mkComposition({
        system_prompt: { tokens: 5000, count: 1 },
        user_text: { tokens: 5000, count: 1 },
      }),
    });
    const result = computeHealthScore(entry, null, new Set(), 1);
    // All audits should be 100
    for (const a of result.audits) {
      assert.equal(a.score, 100, `Audit ${a.id} should be 100, got ${a.score}`);
    }
    assert.equal(result.overall, 100);
  });

  it("rating labels → ≥90 good, 50-89 needs-work, <50 poor", () => {
    // Good case: all healthy
    const goodEntry = mkEntry({
      totalTokens: 10000,
      contextLimit: 200000,
      composition: mkComposition({
        system_prompt: { tokens: 5000, count: 1 },
        user_text: { tokens: 5000, count: 1 },
      }),
    });
    const good = computeHealthScore(goodEntry, null, new Set(), 1);
    assert.equal(good.rating, "good");

    // Poor case: critical utilization + massive tool results + big growth
    const poorEntry = mkEntry({
      totalTokens: 190000,
      contextLimit: 200000,
      composition: mkComposition({
        tool_results: { tokens: 160000, count: 20 },
        tool_definitions: { tokens: 15000, count: 14 },
        thinking: { tokens: 10000, count: 5 },
        system_prompt: { tokens: 3000, count: 1 },
        user_text: { tokens: 1000, count: 2 },
        assistant_text: { tokens: 1000, count: 2 },
      }),
      messages: mkMessages([
        {
          role: "user",
          tokens: 15000,
          contentBlocks: [
            { type: "tool_result", tool_use_id: "t1", content: "x" },
          ],
        },
      ]),
      tools: mkTools(14),
    });
    const poor = computeHealthScore(poorEntry, 130000, new Set(), 10);
    assert.equal(poor.rating, "poor");
  });

  it("early-turn floor: tool usage score ≥ 60 when turnCount ≤ 2", () => {
    // High tool-def overhead, 0 tools used, but early turn
    const entry = mkEntry({
      totalTokens: 20000,
      contextLimit: 200000,
      composition: mkComposition({
        tool_definitions: { tokens: 14000, count: 14 },
        system_prompt: { tokens: 4000, count: 1 },
        user_text: { tokens: 2000, count: 1 },
      }),
      tools: mkTools(14),
    });
    // Same entry at turn 1 (early) vs turn 10 (late)
    const early = computeHealthScore(entry, null, new Set(), 1);
    const late = computeHealthScore(entry, null, new Set(), 10);
    const earlyToolDefs = findAudit(early, "tool-defs");
    const lateToolDefs = findAudit(late, "tool-defs");
    // Early turn should be more lenient
    assert.ok(
      earlyToolDefs.score > lateToolDefs.score,
      `Early (${earlyToolDefs.score}) should be > late (${lateToolDefs.score})`,
    );
  });
});
