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

  it("matches by substring", () => {
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
    assert.equal(fullCost, 10); // $10/M
  });

  it("calculates cache read cost at 10% for Claude models", () => {
    // Claude Sonnet 4: base input = $3/M
    // 100K regular input @ $3/M = $0.30
    // 900K cache read @ $0.30/M (10% of $3) = $0.27
    // Total = $0.57
    const cost = estimateCost("claude-sonnet-4-20250514", 100_000, 0, 900_000, 0);
    assert.equal(cost, 0.57);
  });

  it("calculates cache write cost at 25% for Claude models", () => {
    // Claude Sonnet 4: base input = $3/M
    // 100K regular input @ $3/M = $0.30
    // 400K cache write @ $0.75/M (25% of $3) = $0.30
    // Total = $0.60
    const cost = estimateCost("claude-sonnet-4-20250514", 100_000, 0, 0, 400_000);
    assert.equal(cost, 0.60);
  });

  it("combines all token types correctly for Claude", () => {
    // Claude Opus 4: input = $15/M, output = $75/M
    // 50K regular input @ $15/M = $0.75
    // 100K cache read @ $1.50/M (10%) = $0.15
    // 50K cache write @ $3.75/M (25%) = $0.1875
    // 10K output @ $75/M = $0.75
    // Total = $1.8375
    const cost = estimateCost("claude-opus-4-20250514", 50_000, 10_000, 100_000, 50_000);
    assert.equal(cost, 1.8375);
  });

  it("ignores cache tokens for non-Claude models", () => {
    // GPT-4o-mini doesn't have cache pricing in our model
    // Should only charge for input/output, not cache
    const cost = estimateCost("gpt-4o-mini", 100_000, 10_000, 50_000, 50_000);
    // 100K input @ $0.15/M = $0.015, 10K output @ $0.60/M = $0.006
    // Cache tokens should not add cost
    assert.equal(cost, 0.021);
  });
});
