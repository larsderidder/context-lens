import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectApiFormat,
  detectProvider,
  estimateCost,
  parseContextInfo,
  resolveTargetUrl,
} from "../src/core.js";
import { parseResponseUsage } from "../src/lhar.js";

describe("Gemini support", () => {
  describe("detectProvider", () => {
    it("detects gemini from :generateContent path", () => {
      assert.equal(
        detectProvider("/v1beta/models/gemini-pro:generateContent", {}),
        "gemini",
      );
    });

    it("detects gemini from :streamGenerateContent path", () => {
      assert.equal(
        detectProvider("/v1beta/models/gemini-pro:streamGenerateContent", {}),
        "gemini",
      );
    });

    it("detects gemini from /v1beta/models/ path", () => {
      assert.equal(
        detectProvider("/v1beta/models/gemini-1.5-flash", {}),
        "gemini",
      );
    });

    it("detects gemini from /v1internal: path (Code Assist)", () => {
      assert.equal(detectProvider("/v1internal:predict", {}), "gemini");
    });

    it("detects gemini from x-goog-api-key header", () => {
      assert.equal(
        detectProvider("/any/path", { "x-goog-api-key": "abc" }),
        "gemini",
      );
    });
  });

  describe("detectApiFormat", () => {
    it("detects gemini format for various paths", () => {
      assert.equal(
        detectApiFormat("/v1beta/models/gemini-pro:generateContent"),
        "gemini",
      );
      assert.equal(detectApiFormat("/v1internal:predict"), "gemini");
    });
  });

  describe("parseContextInfo (Gemini)", () => {
    it("parses basic gemini request", () => {
      const body = {
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello Gemini" }],
          },
        ],
        systemInstruction: {
          parts: [{ text: "You are a helpful assistant" }],
        },
        tools: [
          {
            functionDeclarations: [
              {
                name: "get_weather",
                parameters: {
                  type: "object",
                  properties: { location: { type: "string" } },
                },
              },
            ],
          },
        ],
      };
      const info = parseContextInfo("gemini", body, "gemini");
      assert.equal(info.provider, "gemini");
      assert.equal(info.systemPrompts.length, 1);
      assert.equal(
        info.systemPrompts[0].content,
        "You are a helpful assistant",
      );
      assert.equal(info.messages.length, 1);
      assert.equal(info.messages[0].role, "user");
      assert.equal(info.messages[0].content, "Hello Gemini");
      assert.equal(info.tools.length, 1);
      assert.equal((info.tools[0] as any).name, "get_weather");
    });

    it("parses gemini request with multiple parts", () => {
      const body = {
        contents: [
          {
            role: "user",
            parts: [{ text: "Part 1" }, { text: "Part 2" }],
          },
        ],
      };
      const info = parseContextInfo("gemini", body, "gemini");
      assert.equal(info.messages[0].content, "Part 1\nPart 2");
      assert.equal(info.messages[0].contentBlocks?.length, 2);
    });

    it("handles Gemini Code Assist wrapped request", () => {
      const body = {
        request: {
          contents: [{ parts: [{ text: "Code assist request" }] }],
        },
      };
      const info = parseContextInfo("gemini", body, "gemini");
      assert.equal(info.messages.length, 1);
      assert.equal(info.messages[0].content, "Code assist request");
    });

    it("unwraps functionResponse output wrapper", () => {
      const body = {
        contents: [
          {
            role: "model",
            parts: [
              {
                functionCall: {
                  id: "call-1",
                  name: "run_shell_command",
                  args: { command: "ls" },
                },
              },
            ],
          },
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  id: "call-1",
                  name: "run_shell_command",
                  response: { output: "file1.txt\nfile2.txt" },
                },
              },
            ],
          },
        ],
      };
      const info = parseContextInfo("gemini", body, "gemini");
      assert.equal(info.messages.length, 2);
      // tool_use should have the id and name
      const toolUse = info.messages[0].contentBlocks?.[0] as any;
      assert.equal(toolUse.type, "tool_use");
      assert.equal(toolUse.id, "call-1");
      assert.equal(toolUse.name, "run_shell_command");
      // tool_result should unwrap {output: "..."} to just the text
      const toolResult = info.messages[1].contentBlocks?.[0] as any;
      assert.equal(toolResult.type, "tool_result");
      assert.equal(toolResult.tool_use_id, "call-1");
      assert.equal(toolResult.content, "file1.txt\nfile2.txt");
    });

    it("unwraps functionResponse error wrapper", () => {
      const body = {
        contents: [
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  id: "call-2",
                  name: "read_file",
                  response: { error: "File not found" },
                },
              },
            ],
          },
        ],
      };
      const info = parseContextInfo("gemini", body, "gemini");
      const toolResult = info.messages[0].contentBlocks?.[0] as any;
      assert.equal(toolResult.content, "File not found");
    });
  });

  describe("estimateCost (Gemini)", () => {
    it("calculates cost for gemini-1.5-pro", () => {
      // 1M input @ $1.25 + 1M output @ $5 = $6.25
      const cost = estimateCost("gemini-1.5-pro", 1_000_000, 1_000_000);
      assert.equal(cost, 6.25);
    });

    it("calculates cost for gemini-2.0-flash", () => {
      // 1M input @ $0.10 + 1M output @ $0.40 = $0.50
      const cost = estimateCost("gemini-2.0-flash", 1_000_000, 1_000_000);
      assert.equal(cost, 0.5);
    });

    it("calculates cache read cost at 25% for Gemini models", () => {
      // Gemini 2.5 Pro: base input = $1.25/M
      // 5775 non-cached input @ $1.25/M = $0.00721875
      // 196461 cache read @ $0.3125/M (25% of $1.25) = $0.061394...
      // Total input cost ~ $0.068613
      const cost = estimateCost("gemini-2.5-pro", 5775, 0, 196461, 0);
      assert.ok(cost !== null);
      // 5775 * 1.25 / 1M + 196461 * 1.25 * 0.25 / 1M
      // = 0.00721875 + 0.06139406... = 0.068613 (rounded to 6 dp)
      assert.equal(cost, 0.068613);
    });

    it("applies cache pricing to reduce cost vs full-price input", () => {
      // 202236 total input, 196461 cached, 5775 non-cached
      // With cache: 5775 * 1.25/1M + 196461 * 0.3125/1M = $0.068613
      // Without cache: 202236 * 1.25/1M = $0.252795
      const withCache = estimateCost("gemini-2.5-pro", 5775, 0, 196461, 0);
      const withoutCache = estimateCost("gemini-2.5-pro", 202236, 0, 0, 0);
      assert.ok(withCache !== null && withoutCache !== null);
      assert.ok(withCache < withoutCache, "cached cost should be lower");
      // Cache should save roughly 73% on input cost
      const savings = 1 - withCache / withoutCache;
      assert.ok(savings > 0.7, `savings should be > 70%, got ${(savings * 100).toFixed(1)}%`);
    });

    it("does not charge for Gemini cache writes", () => {
      // Gemini has no per-request cache write billing
      const withWrites = estimateCost("gemini-2.5-pro", 100_000, 0, 0, 50_000);
      const withoutWrites = estimateCost("gemini-2.5-pro", 100_000, 0, 0, 0);
      assert.equal(withWrites, withoutWrites);
    });
  });

  describe("parseResponseUsage (Gemini)", () => {
    it("parses non-streaming Gemini response with cache and thinking tokens", () => {
      const resp = {
        modelVersion: "gemini-2.5-pro-preview-05-06",
        usageMetadata: {
          promptTokenCount: 202236,
          cachedContentTokenCount: 196461,
          candidatesTokenCount: 148,
          thoughtsTokenCount: 188,
          totalTokenCount: 202572,
        },
        candidates: [{ finishReason: "STOP" }],
      };
      const usage = parseResponseUsage(resp);
      // inputTokens should be non-cached portion
      assert.equal(usage.inputTokens, 202236 - 196461); // 5775
      assert.equal(usage.outputTokens, 148);
      assert.equal(usage.cacheReadTokens, 196461);
      assert.equal(usage.thinkingTokens, 188);
      assert.equal(usage.model, "gemini-2.5-pro-preview-05-06");
      assert.deepEqual(usage.finishReasons, ["STOP"]);
    });

    it("parses Gemini response without caching", () => {
      const resp = {
        modelVersion: "gemini-2.0-flash",
        usageMetadata: {
          promptTokenCount: 1000,
          candidatesTokenCount: 200,
          totalTokenCount: 1200,
        },
        candidates: [{ finishReason: "STOP" }],
      };
      const usage = parseResponseUsage(resp);
      assert.equal(usage.inputTokens, 1000);
      assert.equal(usage.outputTokens, 200);
      assert.equal(usage.cacheReadTokens, 0);
      assert.equal(usage.thinkingTokens, 0);
    });

    it("parses streaming Gemini response with cache and thinking tokens", () => {
      const chunks = [
        'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}],"usageMetadata":{"promptTokenCount":202236,"cachedContentTokenCount":196461,"candidatesTokenCount":10,"thoughtsTokenCount":50},"modelVersion":"gemini-2.5-pro-preview-05-06"}',
        "",
        'data: {"candidates":[{"content":{"parts":[{"text":" world"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":202236,"cachedContentTokenCount":196461,"candidatesTokenCount":148,"thoughtsTokenCount":188},"modelVersion":"gemini-2.5-pro-preview-05-06"}',
        "",
        "data: [DONE]",
      ].join("\n");
      const usage = parseResponseUsage({ streaming: true, chunks });
      assert.equal(usage.stream, true);
      // Should use the last chunk's values (streaming overwrites)
      assert.equal(usage.inputTokens, 202236 - 196461); // 5775
      assert.equal(usage.outputTokens, 148);
      assert.equal(usage.cacheReadTokens, 196461);
      assert.equal(usage.thinkingTokens, 188);
      assert.equal(usage.model, "gemini-2.5-pro-preview-05-06");
      assert.deepEqual(usage.finishReasons, ["STOP"]);
    });

    it("parses Code Assist wrapped Gemini response", () => {
      const resp = {
        response: {
          modelVersion: "gemini-2.5-pro",
          usageMetadata: {
            promptTokenCount: 5000,
            cachedContentTokenCount: 3000,
            candidatesTokenCount: 100,
            thoughtsTokenCount: 50,
          },
          candidates: [{ finishReason: "STOP" }],
        },
      };
      const usage = parseResponseUsage(resp);
      assert.equal(usage.inputTokens, 5000 - 3000); // 2000
      assert.equal(usage.outputTokens, 100);
      assert.equal(usage.cacheReadTokens, 3000);
      assert.equal(usage.thinkingTokens, 50);
      assert.equal(usage.model, "gemini-2.5-pro");
    });

    it("preserves thinking tokens through compacted response format", () => {
      // Simulates what compactEntry produces (Anthropic-style field names)
      const compacted = {
        usage: {
          input_tokens: 5775,
          output_tokens: 148,
          cache_read_input_tokens: 196461,
          cache_creation_input_tokens: 0,
          thinking_tokens: 188,
        },
        model: "gemini-2.5-pro-preview-05-06",
        stop_reason: "STOP",
      };
      const usage = parseResponseUsage(compacted);
      assert.equal(usage.inputTokens, 5775);
      assert.equal(usage.outputTokens, 148);
      assert.equal(usage.cacheReadTokens, 196461);
      assert.equal(usage.thinkingTokens, 188);
      assert.equal(usage.model, "gemini-2.5-pro-preview-05-06");
    });
  });

  describe("resolveTargetUrl (Gemini)", () => {
    const upstreams = {
      openai: "https://api.openai.com/v1",
      anthropic: "https://api.anthropic.com",
      chatgpt: "https://chatgpt.com",
      gemini: "https://generativelanguage.googleapis.com",
      geminiCodeAssist: "https://cloudcode-pa.googleapis.com",
      vertex: "https://us-central1-aiplatform.googleapis.com",
    };

    it("routes standard gemini paths", () => {
      const result = resolveTargetUrl(
        { pathname: "/v1beta/models/gemini-pro:generateContent" },
        {},
        upstreams,
      );
      assert.equal(
        result.targetUrl,
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
      );
      assert.equal(result.provider, "gemini");
    });

    it("routes code assist gemini paths", () => {
      const result = resolveTargetUrl(
        { pathname: "/v1internal:predict" },
        {},
        upstreams,
      );
      assert.equal(
        result.targetUrl,
        "https://cloudcode-pa.googleapis.com/v1internal:predict",
      );
      assert.equal(result.provider, "gemini");
    });
  });
});
