import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseContextInfo } from "../src/core.js";
import {
  anthropicBasic,
  claudeSession,
  codexResponses,
  openaiChat,
  openaiChatTools,
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
      assert.deepEqual(customCall.input, { sql: "select 1" });

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

    it("parses assistant tool_calls into contentBlocks", () => {
      const info = parseContextInfo(
        "openai",
        openaiChatTools,
        "chat-completions",
      );
      // msg[2] in fixture: assistant with content:null + tool_calls
      const assistantMsg = info.messages.find(
        (m) =>
          m.role === "assistant" &&
          m.contentBlocks?.some((b: any) => b.name === "read_file"),
      );
      assert.ok(assistantMsg, "should find assistant message with read_file");
      assert.ok(assistantMsg!.contentBlocks, "should have contentBlocks");
      const toolUse = assistantMsg!.contentBlocks![0] as any;
      assert.equal(toolUse.type, "tool_use");
      assert.equal(toolUse.id, "call_abc123");
      assert.equal(toolUse.name, "read_file");
      assert.deepEqual(toolUse.input, { path: "/src/auth.js" });
      assert.ok(assistantMsg!.tokens > 0, "tokens should be > 0");
    });

    it("parses role=tool messages as tool results with contentBlocks", () => {
      const info = parseContextInfo(
        "openai",
        openaiChatTools,
        "chat-completions",
      );
      // msg[3] in fixture: role=tool with tool_call_id
      const toolMsg = info.messages.find(
        (m) =>
          m.role === "tool" &&
          m.contentBlocks?.some(
            (b: any) => b.tool_use_id === "call_abc123",
          ),
      );
      assert.ok(toolMsg, "should find tool result message");
      assert.ok(toolMsg!.contentBlocks, "should have contentBlocks");
      const toolResult = toolMsg!.contentBlocks![0] as any;
      assert.equal(toolResult.type, "tool_result");
      assert.equal(toolResult.tool_use_id, "call_abc123");
      assert.ok(
        toolResult.content.includes("express-auth"),
        "should contain tool output",
      );
      assert.ok(toolMsg!.tokens > 0, "tokens should be > 0");
    });

    it("handles assistant with both text content and tool_calls", () => {
      const info = parseContextInfo(
        "openai",
        openaiChatTools,
        "chat-completions",
      );
      // msg[4] in fixture: assistant with text + tool_calls
      const mixedMsg = info.messages.find(
        (m) =>
          m.role === "assistant" &&
          m.contentBlocks?.some((b: any) => b.name === "write_file"),
      );
      assert.ok(mixedMsg, "should find assistant message with write_file");
      const blocks = mixedMsg!.contentBlocks!;
      assert.ok(blocks.length >= 2, "should have text + tool_use blocks");
      const textBlock = blocks.find((b: any) => b.type === "text") as any;
      assert.ok(textBlock, "should have a text block");
      assert.ok(textBlock.text.includes("I found the issue"));
      const toolBlock = blocks.find((b: any) => b.type === "tool_use") as any;
      assert.ok(toolBlock, "should have a tool_use block");
      assert.equal(toolBlock.name, "write_file");
      assert.ok(mixedMsg!.tokens > 0, "tokens should be > 0");
    });

    it("content:null assistant messages have non-zero tokens when tool_calls present", () => {
      const body = {
        model: "gpt-4o",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "test_fn", arguments: '{"key":"value"}' },
              },
            ],
          },
        ],
      };
      const info = parseContextInfo("openai", body, "chat-completions");
      assert.ok(info.messagesTokens > 0, "messagesTokens should be > 0");
      assert.equal(
        info.totalTokens,
        info.systemTokens + info.toolsTokens + info.messagesTokens,
        "totalTokens invariant",
      );
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

  describe("anthropic format - array system prompt", () => {
    it("joins array system blocks into a single systemPrompts entry", () => {
      const body = {
        model: "claude-sonnet-4",
        system: [
          { type: "text", text: "You are helpful." },
          { type: "text", text: "Be concise." },
        ],
        messages: [{ role: "user", content: "hi" }],
      };
      const info = parseContextInfo("anthropic", body, "anthropic-messages");
      assert.equal(info.systemPrompts.length, 1);
      assert.ok(info.systemPrompts[0].content.includes("You are helpful."));
      assert.ok(info.systemPrompts[0].content.includes("Be concise."));
      assert.ok(info.systemTokens > 0);
    });
  });

  describe("gemini format - Code Assist .request wrapper", () => {
    it("unwraps contents and systemInstruction from .request field", () => {
      const body = {
        request: {
          contents: [
            { role: "user", parts: [{ text: "Hello from Code Assist" }] },
          ],
          systemInstruction: {
            parts: [{ text: "You are a coding assistant." }],
          },
        },
      };
      const info = parseContextInfo("gemini", body, "gemini");
      assert.equal(info.systemPrompts.length, 1);
      assert.ok(info.systemPrompts[0].content.includes("coding assistant"));
      assert.equal(info.messages.length, 1);
      assert.equal(info.messages[0].role, "user");
      assert.ok(info.messagesTokens > 0);
    });
  });

  describe("gemini format - Gemini parts varieties", () => {
    it("parses functionCall and functionResponse parts", () => {
      const body = {
        contents: [
          {
            role: "model",
            parts: [
              {
                functionCall: {
                  name: "web_search",
                  args: { query: "TypeScript" },
                },
              },
            ],
          },
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "web_search",
                  response: {
                    output: "TypeScript is a typed superset of JavaScript.",
                  },
                },
              },
            ],
          },
        ],
      };
      const info = parseContextInfo("gemini", body, "gemini");
      assert.equal(info.messages.length, 2);

      const toolUse = info.messages[0].contentBlocks?.[0] as any;
      assert.equal(toolUse?.type, "tool_use");
      assert.equal(toolUse?.name, "web_search");
      assert.deepEqual(toolUse?.input, { query: "TypeScript" });

      const toolResult = info.messages[1].contentBlocks?.[0] as any;
      assert.equal(toolResult?.type, "tool_result");
      assert.ok(toolResult?.content.includes("TypeScript"));
    });

    it("parses inlineData as image blocks", () => {
      const body = {
        contents: [
          {
            role: "user",
            parts: [
              { text: "What is in this image?" },
              { inlineData: { mimeType: "image/png", data: "base64data" } },
            ],
          },
        ],
      };
      const info = parseContextInfo("gemini", body, "gemini");
      assert.equal(info.messages.length, 1);
      const imageBlock = info.messages[0].contentBlocks?.find(
        (b: any) => b.type === "image",
      );
      assert.ok(imageBlock, "should have image content block");
    });

    it("maps model role to assistant", () => {
      const body = {
        contents: [
          { role: "model", parts: [{ text: "I can help with that." }] },
        ],
      };
      const info = parseContextInfo("gemini", body, "gemini");
      assert.equal(info.messages[0].role, "assistant");
    });

    it("extracts functionResponse error wrapper as tool result content", () => {
      const body = {
        contents: [
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "run_command",
                  response: { error: "command not found: foo" },
                },
              },
            ],
          },
        ],
      };
      const info = parseContextInfo("gemini", body, "gemini");
      const toolResult = info.messages[0].contentBlocks?.[0] as any;
      assert.equal(toolResult?.type, "tool_result");
      assert.ok(toolResult?.content.includes("command not found"));
    });

    it("parses executableCode and codeExecutionResult parts as text", () => {
      const body = {
        contents: [
          {
            role: "model",
            parts: [
              {
                executableCode: { language: "python", code: "print('hello')" },
              },
              {
                codeExecutionResult: {
                  outcome: "OUTCOME_OK",
                  output: "hello\n",
                },
              },
            ],
          },
        ],
      };
      const info = parseContextInfo("gemini", body, "gemini");
      assert.equal(info.messages.length, 1);
      // Both parts should be captured as content blocks
      const blocks = info.messages[0].contentBlocks ?? [];
      assert.ok(blocks.length >= 2, "should have at least 2 content blocks");
    });

    it("includes Gemini tools from functionDeclarations", () => {
      const body = {
        tools: [
          {
            functionDeclarations: [
              {
                name: "get_weather",
                description: "Get the current weather",
              },
            ],
          },
        ],
        contents: [{ role: "user", parts: [{ text: "What's the weather?" }] }],
      };
      const info = parseContextInfo("gemini", body, "gemini");
      assert.equal(info.tools.length, 1);
      assert.equal((info.tools[0] as any).name, "get_weather");
      assert.ok(info.toolsTokens > 0);
    });
  });

  describe("totalTokens invariant", () => {
    it("totalTokens always equals system + tools + messages across formats", () => {
      const cases = [
        ["anthropic", anthropicBasic, "anthropic-messages"],
        ["openai", codexResponses, "responses"],
        ["openai", openaiChat, "chat-completions"],
      ] as const;

      for (const [provider, body, format] of cases) {
        const info = parseContextInfo(provider, body, format);
        assert.equal(
          info.totalTokens,
          info.systemTokens + info.toolsTokens + info.messagesTokens,
          `${provider}/${format}: totalTokens invariant broken`,
        );
      }
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
