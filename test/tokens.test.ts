import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { estimateTokens } from "../src/core.js";

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
