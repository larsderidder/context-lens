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
});
