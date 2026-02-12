import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseContextInfo } from "../src/core.js";
import {
  anthropicBasic,
  claudeSession,
  codexResponses,
  openaiChat,
} from "./helpers/fixtures.js";

describe("parseContextInfo", () => {
  describe("anthropic format", () => {
    it("parses system prompt, tools, and messages", () => {
      const info = parseContextInfo(
        "anthropic",
        anthropicBasic,
        "anthropic-messages",
      );
      assert.equal(info.provider, "anthropic");
      assert.equal(info.model, "claude-sonnet-4-20250514");
      assert.equal(info.systemPrompts.length, 1);
      assert.ok(info.systemPrompts[0].content.includes("helpful assistant"));
      assert.equal(info.tools.length, 1);
      assert.equal((info.tools[0] as any).name, "get_weather");
      assert.equal(info.messages.length, 3);
      assert.equal(info.messages[0].role, "user");
      assert.ok(info.systemTokens > 0);
      assert.ok(info.toolsTokens > 0);
      assert.ok(info.messagesTokens > 0);
      assert.equal(
        info.totalTokens,
        info.systemTokens + info.toolsTokens + info.messagesTokens,
      );
    });

    it("preserves content blocks for array content", () => {
      const info = parseContextInfo(
        "anthropic",
        claudeSession,
        "anthropic-messages",
      );
      // First user message has array content
      assert.ok(info.messages[0].contentBlocks);
      assert.equal(info.messages[0].contentBlocks?.length, 2);
      // Assistant message has array content with tool_use
      assert.ok(info.messages[1].contentBlocks);
    });

    it("handles missing optional fields", () => {
      const info = parseContextInfo(
        "anthropic",
        { model: "claude-3", messages: [] },
        "anthropic-messages",
      );
      assert.equal(info.systemPrompts.length, 0);
      assert.equal(info.tools.length, 0);
      assert.equal(info.messages.length, 0);
      assert.equal(info.totalTokens, 0);
    });
  });

  describe("responses API format", () => {
    it("parses instructions, input array, and tools", () => {
      const info = parseContextInfo("openai", codexResponses, "responses");
      assert.equal(info.systemPrompts.length, 1);
      assert.ok(info.systemPrompts[0].content.includes("coding assistant"));
      assert.ok(info.messages.length >= 4); // user + assistant messages from input
      assert.equal(info.tools.length, 1);
    });

    it("handles string input", () => {
      const body = { model: "gpt-4o", input: "Hello world" };
      const info = parseContextInfo("openai", body, "responses");
      assert.equal(info.messages.length, 1);
      assert.equal(info.messages[0].content, "Hello world");
    });

    it("separates system messages from input array", () => {
      const body = {
        model: "gpt-4o",
        input: [
          { role: "system", content: "Be helpful" },
          { role: "user", content: "Hi" },
        ],
      };
      const info = parseContextInfo("openai", body, "responses");
      assert.equal(info.systemPrompts.length, 1);
      assert.equal(info.messages.length, 1);
    });

    it("parses typed responses input items into normalized message blocks", () => {
      const body = {
        model: "gpt-4o",
        input: [
          {
            role: "developer",
            content: [{ type: "input_text", text: "System policy" }],
          },
          {
            type: "function_call",
            call_id: "call_1",
            name: "search_docs",
            arguments: { q: "auth flow" },
          },
          {
            type: "custom_tool_call",
            call_id: "call_2",
            name: "run_sql",
            arguments: '{"sql":"select 1"}',
          },
          {
            type: "function_call_output",
            call_id: "call_1",
            output: { text: "found 12 docs" },
          },
          {
            type: "custom_tool_call_output",
            call_id: "call_2",
            output: "ok",
          },
          {
            type: "reasoning",
            summary: [{ text: "thinking summary" }],
          },
          { type: "output_text", text: "assistant answer" },
          { type: "input_text", text: "follow-up question" },
          { type: "unknown_event", payload: 123 },
        ],
      };

      const info = parseContextInfo("openai", body, "responses");

      assert.equal(info.systemPrompts.length, 1);
      assert.equal(info.systemPrompts[0].content, "System policy");
      assert.equal(info.messages.length, 8);

      const call = info.messages[0].contentBlocks?.[0] as any;
      assert.equal(call.type, "tool_use");
      assert.equal(call.id, "call_1");
      assert.equal(call.name, "search_docs");
      assert.deepEqual(call.input, { q: "auth flow" });

      const customCall = info.messages[1].contentBlocks?.[0] as any;
      assert.equal(customCall.type, "tool_use");
      assert.equal(customCall.id, "call_2");
      assert.deepEqual(customCall.input, {});

      const output = info.messages[2].contentBlocks?.[0] as any;
      assert.equal(output.type, "tool_result");
      assert.equal(output.tool_use_id, "call_1");
      assert.equal(output.content, JSON.stringify({ text: "found 12 docs" }));

      const customOutput = info.messages[3].contentBlocks?.[0] as any;
      assert.equal(customOutput.type, "tool_result");
      assert.equal(customOutput.tool_use_id, "call_2");
      assert.equal(customOutput.content, "ok");

      const thinking = info.messages[4].contentBlocks?.[0] as any;
      assert.equal(thinking.type, "thinking");
      assert.equal(thinking.thinking, "thinking summary");

      assert.equal(info.messages[5].role, "assistant");
      assert.equal(info.messages[5].content, "assistant answer");
      assert.equal(info.messages[6].role, "user");
      assert.equal(info.messages[6].content, "follow-up question");
      assert.equal(
        info.messages[7].content,
        JSON.stringify({ type: "unknown_event", payload: 123 }),
      );
    });

    it("falls back to [reasoning] when reasoning summary is absent", () => {
      const body = {
        model: "gpt-4o",
        input: [{ type: "reasoning" }],
      };
      const info = parseContextInfo("openai", body, "responses");
      assert.equal(info.messages.length, 1);
      assert.equal(info.messages[0].content, "[reasoning]");
      const thinking = info.messages[0].contentBlocks?.[0] as any;
      assert.equal(thinking.type, "thinking");
      assert.equal(thinking.thinking, "[reasoning]");
    });
  });

  describe("openai chat completions", () => {
    it("separates system/developer messages from user/assistant", () => {
      const info = parseContextInfo("openai", openaiChat, "chat-completions");
      assert.equal(info.systemPrompts.length, 1);
      assert.ok(
        info.systemPrompts[0].content.includes("expert software developer"),
      );
      // user + assistant + user = 3 non-system messages
      assert.equal(info.messages.length, 3);
      assert.equal(info.tools.length, 1);
    });

    it("handles developer role as system", () => {
      const body = {
        model: "gpt-4o",
        messages: [
          { role: "developer", content: "System instruction" },
          { role: "user", content: "Hi" },
        ],
      };
      const info = parseContextInfo("openai", body, "chat-completions");
      assert.equal(info.systemPrompts.length, 1);
      assert.equal(info.systemPrompts[0].content, "System instruction");
    });

    it("handles legacy functions field", () => {
      const body = {
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: "Hi" }],
        functions: [{ name: "search", description: "Search the web" }],
      };
      const info = parseContextInfo("openai", body, "chat-completions");
      assert.equal(info.tools.length, 1);
      assert.equal((info.tools[0] as any).name, "search");
    });
  });

  describe("chatgpt backend", () => {
    it("parses instructions and input array", () => {
      const body = {
        model: "gpt-4o",
        instructions: "Be a coder",
        input: [{ role: "user", content: "Fix the bug" }],
      };
      const info = parseContextInfo("chatgpt", body, "chatgpt-backend");
      assert.equal(info.systemPrompts.length, 1);
      assert.equal(info.messages.length, 1);
    });

    it("handles both instructions and system fields", () => {
      const body = {
        model: "gpt-4o",
        instructions: "Instruction 1",
        system: "System 2",
        input: [{ role: "user", content: "Hi" }],
      };
      const info = parseContextInfo("chatgpt", body, "chatgpt-backend");
      assert.equal(info.systemPrompts.length, 2);
    });
  });

  describe("empty body", () => {
    it("returns zeroed info for empty body", () => {
      const info = parseContextInfo("unknown", {}, "unknown");
      assert.equal(info.model, "unknown");
      assert.equal(info.totalTokens, 0);
      assert.equal(info.messages.length, 0);
    });
  });
});
