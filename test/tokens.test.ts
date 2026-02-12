import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { estimateTokens } from "../src/core.js";
import { rescaleContextTokens } from "../src/core/tokens.js";
import type { ContextInfo } from "../src/types.js";

function makeContextInfo(overrides: Partial<ContextInfo> = {}): ContextInfo {
  return {
    provider: "anthropic",
    apiFormat: "anthropic-messages",
    model: "claude-sonnet-4",
    systemTokens: 100,
    toolsTokens: 50,
    messagesTokens: 50,
    totalTokens: 200,
    systemPrompts: [],
    tools: [],
    messages: [
      { role: "user", content: "hello", tokens: 20 },
      { role: "assistant", content: "hi there friend", tokens: 30 },
    ],
    ...overrides,
  };
}

describe("estimateTokens", () => {
  it("estimates string tokens as chars/4", () => {
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("abcde"), 2); // ceil(5/4)
    assert.equal(estimateTokens("hello world!"), 3); // ceil(12/4)
  });

  it("returns 0 for null/undefined/empty", () => {
    assert.equal(estimateTokens(null), 0);
    assert.equal(estimateTokens(undefined), 0);
    assert.equal(estimateTokens(""), 0);
  });

  it("stringifies objects before counting", () => {
    const obj = { key: "value" };
    const expected = Math.ceil(JSON.stringify(obj).length / 4);
    assert.equal(estimateTokens(obj), expected);
  });

  it("uses fixed estimate for Anthropic image blocks", () => {
    const imageBlock = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "A".repeat(1_000_000) },
    };
    const tokens = estimateTokens(imageBlock);
    // Should be ~1,600 (fixed estimate), not ~250,000 (1M/4)
    assert.ok(tokens < 5_000, `Expected <5,000 but got ${tokens}`);
    assert.ok(tokens >= 1_600, `Expected >=1,600 but got ${tokens}`);
  });

  it("uses fixed estimate for OpenAI image_url blocks", () => {
    const imageBlock = {
      type: "image_url",
      image_url: { url: "data:image/png;base64," + "A".repeat(500_000) },
    };
    const tokens = estimateTokens(imageBlock);
    assert.ok(tokens < 5_000, `Expected <5,000 but got ${tokens}`);
  });

  it("handles content arrays with mixed text and images", () => {
    const content = [
      { type: "text", text: "Here is a screenshot:" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(2_000_000) } },
      { type: "text", text: "What do you see?" },
    ];
    const tokens = estimateTokens(content);
    // Should be text tokens + ~1,600 for image, not ~500,000+
    assert.ok(tokens < 5_000, `Expected <5,000 but got ${tokens}`);
    assert.ok(tokens >= 1_600, `Expected >=1,600 but got ${tokens}`);
  });

  it("handles tool_result blocks with nested images", () => {
    const content = [
      {
        type: "tool_result",
        tool_use_id: "toolu_123",
        content: [
          { type: "text", text: "Read image file [image/png]" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(3_000_000) } },
        ],
      },
    ];
    const tokens = estimateTokens(content);
    // Should be metadata + text + ~1,600, not ~750,000+
    assert.ok(tokens < 5_000, `Expected <5,000 but got ${tokens}`);
    assert.ok(tokens >= 1_600, `Expected >=1,600 but got ${tokens}`);
  });

  it("counts multiple images separately", () => {
    const content = [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(1_000_000) } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "B".repeat(1_000_000) } },
    ];
    const tokens = estimateTokens(content);
    // Should be ~3,200 (2 * 1,600) plus small overhead, not ~500,000
    assert.ok(tokens >= 3_200, `Expected >=3,200 but got ${tokens}`);
    assert.ok(tokens < 10_000, `Expected <10,000 but got ${tokens}`);
  });

  it("handles Gemini inlineData blocks", () => {
    const block = {
      inlineData: { mimeType: "image/png", data: "A".repeat(1_000_000) },
    };
    const tokens = estimateTokens(block);
    assert.ok(tokens < 5_000, `Expected <5,000 but got ${tokens}`);
    assert.ok(tokens >= 1_600, `Expected >=1,600 but got ${tokens}`);
  });
});

describe("rescaleContextTokens", () => {
  it("rescales sub-totals and per-message tokens proportionally", () => {
    const ci = makeContextInfo();
    rescaleContextTokens(ci, 400); // 2x scale
    assert.equal(ci.systemTokens, 200);
    assert.equal(ci.toolsTokens, 100);
    assert.equal(ci.messages[0].tokens, 40);
    assert.equal(ci.messages[1].tokens, 60);
    assert.equal(ci.totalTokens, 400);
  });

  it("preserves invariant: total === system + tools + messages", () => {
    const ci = makeContextInfo();
    // Scale that causes rounding: 200 -> 301
    rescaleContextTokens(ci, 301);
    assert.equal(
      ci.totalTokens,
      ci.systemTokens + ci.toolsTokens + ci.messagesTokens,
      "invariant broken: totalTokens !== system + tools + messages",
    );
    assert.equal(ci.totalTokens, 301);
  });

  it("ensures messagesTokens equals sum of per-message tokens after rounding fix", () => {
    // Exhaustive check: try 1000 scale targets with values designed to
    // maximize rounding residual (3 messages, prime-ish sub-totals).
    for (let auth = 1; auth <= 1000; auth++) {
      const ci = makeContextInfo({
        systemTokens: 33,
        toolsTokens: 33,
        messagesTokens: 34,
        totalTokens: 100,
        messages: [
          { role: "user", content: "a", tokens: 11 },
          { role: "assistant", content: "b", tokens: 11 },
          { role: "user", content: "c", tokens: 12 },
        ],
      });
      rescaleContextTokens(ci, auth);
      const msgSum = ci.messages.reduce((s, m) => s + m.tokens, 0);
      assert.equal(
        ci.messagesTokens,
        msgSum,
        `at auth=${auth}: messagesTokens (${ci.messagesTokens}) !== sum(msg.tokens) (${msgSum})`,
      );
      assert.equal(
        ci.totalTokens,
        ci.systemTokens + ci.toolsTokens + ci.messagesTokens,
        `at auth=${auth}: outer invariant broken`,
      );
    }
  });

  it("no-ops when authoritative equals estimated", () => {
    const ci = makeContextInfo();
    rescaleContextTokens(ci, 200);
    assert.equal(ci.systemTokens, 100);
    assert.equal(ci.toolsTokens, 50);
    assert.equal(ci.messagesTokens, 50);
    assert.equal(ci.messages[0].tokens, 20);
    assert.equal(ci.messages[1].tokens, 30);
    assert.equal(ci.totalTokens, 200);
  });

  it("handles zero estimated gracefully", () => {
    const ci = makeContextInfo({
      systemTokens: 0,
      toolsTokens: 0,
      messagesTokens: 0,
      totalTokens: 0,
      messages: [],
    });
    // Should not throw or divide by zero
    rescaleContextTokens(ci, 0);
    assert.equal(ci.totalTokens, 0);
  });

  it("handles zero authoritative gracefully", () => {
    const ci = makeContextInfo();
    rescaleContextTokens(ci, 0);
    assert.equal(ci.totalTokens, 0);
    assert.equal(ci.systemTokens, 0);
    assert.equal(ci.toolsTokens, 0);
    assert.equal(ci.messagesTokens, 0);
    for (const msg of ci.messages) {
      assert.equal(msg.tokens, 0);
    }
  });
});
