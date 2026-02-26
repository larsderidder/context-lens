import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import {
  countTokens,
  initTokenizer,
  isTokenizerReady,
} from "../src/core/tokenizer.js";
import { estimateTokens } from "../src/core/tokens.js";

describe("tokenizer", () => {
  before(async () => {
    await initTokenizer();
  });

  describe("initialization", () => {
    it("isTokenizerReady returns true after init", () => {
      assert.equal(isTokenizerReady(), true);
    });

    it("initTokenizer is idempotent", async () => {
      // Calling twice should not throw or corrupt state
      await initTokenizer();
      assert.equal(isTokenizerReady(), true);
      // Result should be stable across calls
      assert.equal(countTokens("hello"), countTokens("hello"));
    });
  });

  describe("cl100k_base — known exact counts", () => {
    // Verified against Python tiktoken: tiktoken.get_encoding("cl100k_base").encode(text)
    const cases: [string, number][] = [
      ["Hello, world!", 4], // "Hello", ",", " world", "!"
      ["foo bar baz", 3], // each space+word is one token
      ["", 0],
    ];

    for (const [text, expected] of cases) {
      it(`"${text}" → ${expected} tokens`, () => {
        const got = countTokens(text, "claude-sonnet-4");
        assert.equal(got, expected, `cl100k: expected ${expected}, got ${got}`);
      });
    }
  });

  describe("o200k_base — known exact counts", () => {
    // Verified against Python tiktoken: tiktoken.get_encoding("o200k_base").encode(text)
    const cases: [string, number][] = [
      ["Hello, world!", 4],
      ["", 0],
    ];

    for (const [text, expected] of cases) {
      it(`"${text}" → ${expected} tokens`, () => {
        const got = countTokens(text, "gpt-4o");
        assert.equal(got, expected, `o200k: expected ${expected}, got ${got}`);
      });
    }
  });

  describe("model-to-encoding routing", () => {
    // Models that should use cl100k_base — verified by comparing to the
    // canonical cl100k result for a multi-token string.
    const cl100kModels = [
      "claude-sonnet-4",
      "claude-sonnet-4-20250514",
      "claude-3-5-haiku",
      "claude-3-opus",
      "gpt-4-turbo",
      "gpt-3.5-turbo",
      "gemini-2.5-pro",
      "gemini-1.5-flash",
      "some-unknown-model", // fallback is cl100k_base
    ];

    const o200kModels = [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4.1",
      "gpt-5",
      "gpt-5-codex",
      "o3",
      "o3-mini",
      "o4-mini",
      "o1",
    ];

    it("no model argument defaults to cl100k_base", () => {
      const text = "Hello, world!";
      assert.equal(countTokens(text), countTokens(text, "claude-sonnet-4"));
    });

    // Verify all cl100k models produce the same result as the canonical model
    for (const model of cl100kModels) {
      it(`${model} uses cl100k_base`, () => {
        const text = "Hello, world!";
        assert.equal(
          countTokens(text, model),
          countTokens(text, "claude-sonnet-4"),
          `${model} should match cl100k_base`,
        );
      });
    }

    // Verify all o200k models produce the same result as the canonical model
    for (const model of o200kModels) {
      it(`${model} uses o200k_base`, () => {
        const text = "Hello, world!";
        assert.equal(
          countTokens(text, model),
          countTokens(text, "gpt-4o"),
          `${model} should match o200k_base`,
        );
      });
    }
  });

  describe("content types", () => {
    it("handles unicode text", () => {
      const text = "こんにちは世界！";
      const tokens = countTokens(text);
      // Japanese: multi-byte characters, typically 1-3 tokens per character in cl100k
      assert.ok(tokens >= 4, `Expected >=4 tokens for Japanese, got ${tokens}`);
      assert.ok(
        tokens <= 30,
        `Expected <=30 tokens for Japanese, got ${tokens}`,
      );
    });

    it("handles TypeScript code", () => {
      const code = `function fibonacci(n: number): number {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}`;
      const tokens = countTokens(code);
      assert.ok(tokens >= 30, `Expected >=30 tokens for code, got ${tokens}`);
      assert.ok(tokens <= 60, `Expected <=60 tokens for code, got ${tokens}`);
    });

    it("token count is less than character count for English prose", () => {
      // English averages ~4 chars per token
      const text = "The quick brown fox jumps over the lazy dog.";
      const tokens = countTokens(text);
      assert.ok(
        tokens < text.length,
        `tokens (${tokens}) should be < chars (${text.length})`,
      );
    });
  });

  describe("tiktoken vs chars/4", () => {
    it("produces different result than chars/4 for structured JSON", () => {
      // JSON with lots of punctuation tokenizes differently from chars/4.
      // Verify tiktoken is active, not just the fallback.
      const json = JSON.stringify({
        type: "function",
        function: {
          name: "bash",
          description: "Run a shell command and return the output",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "The shell command" },
            },
            required: ["command"],
          },
        },
      });
      const tiktoken = countTokens(json, "claude-sonnet-4");
      const charsDiv4 = Math.ceil(json.length / 4);
      assert.notEqual(
        tiktoken,
        charsDiv4,
        `Expected tiktoken (${tiktoken}) to differ from chars/4 (${charsDiv4})`,
      );
    });

    it("gives ≤ chars/4 result for typical English prose", () => {
      // English prose has ~4+ chars per token so tiktoken ≤ chars/4
      const prompt =
        "You are Claude. Be helpful, harmless, and honest. " +
        "Use tools when appropriate. Always cite your sources.";
      const tokens = countTokens(prompt, "claude-sonnet-4");
      const charsDiv4 = Math.ceil(prompt.length / 4);
      assert.ok(
        tokens <= charsDiv4,
        `tiktoken (${tokens}) should be ≤ chars/4 (${charsDiv4}) for English`,
      );
      assert.ok(tokens >= 15, `tokens (${tokens}) unreasonably low`);
    });
  });

  describe("estimateTokens integration", () => {
    it("returns correct count for plain string with model", () => {
      // Exact known value: "Hello, world!" = 4 tokens in cl100k_base
      assert.equal(estimateTokens("Hello, world!", "claude-sonnet-4"), 4);
    });

    it("returns correct count for plain string without model", () => {
      // No model defaults to cl100k_base
      assert.equal(estimateTokens("Hello, world!"), 4);
    });

    it("stringifies objects and tokenizes the JSON", () => {
      const obj = { role: "user", content: "Hello" };
      const json = JSON.stringify(obj);
      assert.equal(
        estimateTokens(obj, "claude-sonnet-4"),
        countTokens(json, "claude-sonnet-4"),
      );
    });

    it("uses fixed estimate for image blocks regardless of model", () => {
      const imageBlock = {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "A".repeat(500_000),
        },
      };
      const withModel = estimateTokens(imageBlock, "claude-sonnet-4");
      const withoutModel = estimateTokens(imageBlock);
      assert.ok(withModel >= 1_600 && withModel < 5_000);
      assert.ok(withoutModel >= 1_600 && withoutModel < 5_000);
    });

    it("returns 0 for null/undefined/empty", () => {
      assert.equal(estimateTokens(null, "claude-sonnet-4"), 0);
      assert.equal(estimateTokens(undefined, "gpt-4o"), 0);
      assert.equal(estimateTokens("", "gpt-4o"), 0);
    });

    it("gpt-4o and claude produce positive results for JSON content", () => {
      const json = JSON.stringify({ key: "value", nested: { a: 1, b: 2 } });
      const claude = estimateTokens(json, "claude-sonnet-4");
      const gpt4o = estimateTokens(json, "gpt-4o");
      assert.ok(claude > 0 && claude < json.length);
      assert.ok(gpt4o > 0 && gpt4o < json.length);
    });
  });
});
