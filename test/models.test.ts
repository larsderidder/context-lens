import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { estimateCost, getContextLimit } from "../src/core.js";

describe("getContextLimit", () => {
  it("returns correct limit for exact model names", () => {
    assert.equal(getContextLimit("claude-sonnet-4-20250514"), 200000);
    assert.equal(getContextLimit("gpt-4o-mini"), 128000);
    assert.equal(getContextLimit("gpt-4"), 8192);
    assert.equal(getContextLimit("gpt-3.5-turbo"), 16385);
  });

  it("recognizes latest and dated model aliases", () => {
    assert.equal(getContextLimit("claude-sonnet-4-latest"), 200000);
    assert.equal(getContextLimit("gpt-4o-mini-2024-07-18"), 128000);
  });

  it("returns 128000 fallback for unknown models", () => {
    assert.equal(getContextLimit("unknown-model"), 128000);
    assert.equal(getContextLimit("llama-70b"), 128000);
  });
});

describe("estimateCost", () => {
  it("calculates cost for claude-sonnet-4", () => {
    // 1M input @ $3 + 1M output @ $15 = $18
    const cost = estimateCost("claude-sonnet-4-20250514", 1_000_000, 1_000_000);
    assert.equal(cost, 18);
  });

  it("calculates cost for claude-opus-4", () => {
    // 100K input @ $15/M + 10K output @ $75/M = $1.5 + $0.75 = $2.25
    const cost = estimateCost("claude-opus-4-20250514", 100_000, 10_000);
    assert.equal(cost, 2.25);
  });

  it("calculates cost for gpt-4o-mini", () => {
    // 500K input @ $0.15/M + 100K output @ $0.60/M = $0.075 + $0.06 = $0.135
    const cost = estimateCost("gpt-4o-mini-2024-07-18", 500_000, 100_000);
    assert.equal(cost, 0.135);
  });

  it("returns null for unknown models", () => {
    const cost = estimateCost("llama-3.3-70b", 100_000, 10_000);
    assert.equal(cost, null);
  });

  it("returns 0 for zero tokens", () => {
    const cost = estimateCost("claude-sonnet-4", 0, 0);
    assert.equal(cost, 0);
  });

  it("matches gpt-4o-mini before gpt-4o (specificity ordering)", () => {
    const miniCost = estimateCost("gpt-4o-mini", 1_000_000, 0);
    const fullCost = estimateCost("gpt-4o", 1_000_000, 0);
    assert.equal(miniCost, 0.15); // $0.15/M
    assert.equal(fullCost, 2.5); // $2.50/M
  });

  it("matches o3-mini before o3 (specificity ordering)", () => {
    const miniCost = estimateCost("o3-mini-2025-01-31", 1_000_000, 0);
    const fullCost = estimateCost("o3-2025-04-16", 1_000_000, 0);
    assert.equal(miniCost, 1.1); // $1.10/M
    assert.equal(fullCost, 2); // $2/M (current OpenAI API pricing)
  });

  it("calculates cache read cost at 10% for Claude models", () => {
    // Claude Sonnet 4: base input = $3/M
    // 100K regular input @ $3/M = $0.30
    // 900K cache read @ $0.30/M (10% of $3) = $0.27
    // Total = $0.57
    const cost = estimateCost(
      "claude-sonnet-4-20250514",
      100_000,
      0,
      900_000,
      0,
    );
    assert.equal(cost, 0.57);
  });

  it("calculates cache write cost at 125% for Claude models", () => {
    // Claude Sonnet 4: base input = $3/M
    // 100K regular input @ $3/M = $0.30
    // 400K cache write @ $3.75/M (125% of $3) = $1.50
    // Total = $1.80
    const cost = estimateCost(
      "claude-sonnet-4-20250514",
      100_000,
      0,
      0,
      400_000,
    );
    assert.equal(cost, 1.8);
  });

  it("combines all token types correctly for Claude", () => {
    // Claude Opus 4: input = $15/M, output = $75/M
    // 50K regular input @ $15/M = $0.75
    // 100K cache read @ $1.50/M (10%) = $0.15
    // 50K cache write @ $18.75/M (125%) = $0.9375
    // 10K output @ $75/M = $0.75
    // Total = $2.5875
    const cost = estimateCost(
      "claude-opus-4-20250514",
      50_000,
      10_000,
      100_000,
      50_000,
    );
    assert.equal(cost, 2.5875);
  });

  it("ignores cache tokens for non-Claude models", () => {
    // GPT-4o-mini doesn't have cache pricing in our model
    // Should only charge for input/output, not cache
    const cost = estimateCost("gpt-4o-mini", 100_000, 10_000, 50_000, 50_000);
    // 100K input @ $0.15/M = $0.015, 10K output @ $0.60/M = $0.006
    // Cache tokens should not add cost
    assert.equal(cost, 0.021);
  });

  it("calculates cost for gpt-4.1", () => {
    // 500K input @ $2/M + 50K output @ $8/M = $1.00 + $0.40 = $1.40
    const cost = estimateCost("gpt-4.1", 500_000, 50_000);
    assert.equal(cost, 1.4);
  });

  it("calculates cost for gpt-4.1-mini", () => {
    // 1M input @ $0.40/M + 1M output @ $1.60/M = $0.40 + $1.60 = $2.00
    const cost = estimateCost("gpt-4.1-mini", 1_000_000, 1_000_000);
    assert.equal(cost, 2.0);
  });

  it("matches gpt-4.1-mini before gpt-4.1 (specificity ordering)", () => {
    const miniCost = estimateCost("gpt-4.1-mini", 1_000_000, 0) ?? 0;
    const fullCost = estimateCost("gpt-4.1", 1_000_000, 0) ?? 0;
    assert.ok(
      miniCost < fullCost,
      "gpt-4.1-mini should be cheaper per token than gpt-4.1",
    );
  });

  it("calculates cost for gemini-2.5-pro", () => {
    // 100K input @ $1.25/M + 10K output @ $10/M = $0.125 + $0.10 = $0.225
    const cost = estimateCost("gemini-2.5-pro", 100_000, 10_000);
    assert.equal(cost, 0.225);
  });

  it("calculates cost for gemini-2.5-flash", () => {
    // 1M input @ $0.30/M + 100K output @ $2.50/M = $0.30 + $0.25 = $0.55
    const cost = estimateCost("gemini-2.5-flash", 1_000_000, 100_000);
    assert.equal(cost, 0.55);
  });

  it("matches gemini-2.5-flash before gemini-2.5 (specificity ordering)", () => {
    const flashCost = estimateCost("gemini-2.5-flash", 1_000_000, 0) ?? 0;
    const proCost = estimateCost("gemini-2.5-pro", 1_000_000, 0) ?? 0;
    assert.ok(flashCost < proCost, "flash should be cheaper than pro");
  });

  it("calculates cost for claude-sonnet-4.5", () => {
    // Same pricing as sonnet-4: $3/M input, $15/M output
    // 100K input @ $3/M + 10K output @ $15/M = $0.30 + $0.15 = $0.45
    const cost = estimateCost("claude-sonnet-4.5", 100_000, 10_000);
    assert.equal(cost, 0.45);
  });

  it("calculates cost for claude-haiku-4", () => {
    // $0.80/M input, $4/M output
    // 1M input @ $0.80/M + 100K output @ $4/M = $0.80 + $0.40 = $1.20
    const cost = estimateCost("claude-haiku-4", 1_000_000, 100_000);
    assert.equal(cost, 1.2);
  });
});

describe("getContextLimit - extended models", () => {
  it("returns 200_000 for Claude Sonnet 4 and 4.5", () => {
    assert.equal(getContextLimit("claude-sonnet-4"), 200_000);
    assert.equal(getContextLimit("claude-sonnet-4.5"), 200_000);
  });

  it("uses total GPT-5 windows while keeping Chat variants separate", () => {
    assert.equal(getContextLimit("gpt-5"), 400_000);
    assert.equal(getContextLimit("openai/gpt-5.2-codex"), 400_000);
    assert.equal(getContextLimit("gpt-5.2-chat-latest"), 128_000);
  });

  it("does not inherit metadata for unknown model variants", () => {
    assert.equal(getContextLimit("gpt-5.4"), 128_000);
    assert.equal(estimateCost("gpt-5.4", 1000, 500), null);
  });

  it("uses published MiniMax metadata for native IDs", () => {
    assert.equal(getContextLimit("MiniMax-M2.5"), 204_800);
    assert.equal(estimateCost("MiniMax-M2.5", 1_000_000, 0), 0.3);
    assert.equal(estimateCost("MiniMax-M2.5-highspeed", 0, 1_000_000), 2.4);
  });

  it("returns 1_047_576 for gpt-4.1 family", () => {
    assert.equal(getContextLimit("gpt-4.1"), 1_047_576);
    assert.equal(getContextLimit("gpt-4.1-mini"), 1_047_576);
    assert.equal(getContextLimit("gpt-4.1-nano"), 1_047_576);
  });

  it("returns 1_048_576 for gemini-2.5 family", () => {
    assert.equal(getContextLimit("gemini-2.5-pro"), 1_048_576);
    assert.equal(getContextLimit("gemini-2.5-flash"), 1_048_576);
    assert.equal(getContextLimit("gemini-2.0-flash"), 1_048_576);
  });

  it("returns 200_000 for o3 family", () => {
    assert.equal(getContextLimit("o3"), 200_000);
    assert.equal(getContextLimit("o3-mini"), 200_000);
  });
});
