import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractToolsUsed } from "../src/core.js";
import type { ParsedMessage } from "../src/types.js";

describe("extractToolsUsed", () => {
  it("extracts tool names from tool_use blocks", () => {
    const messages: ParsedMessage[] = [
      {
        role: "user",
        content: "Can you read the file?",
        tokens: 10,
        contentBlocks: [{ type: "text", text: "Can you read the file?" }],
      },
      {
        role: "assistant",
        content: "",
        tokens: 20,
        contentBlocks: [{ type: "tool_use", id: "1", name: "Read", input: {} }],
      },
      {
        role: "user",
        content: "",
        tokens: 5,
        contentBlocks: [
          { type: "tool_result", tool_use_id: "1", content: "file contents" },
        ],
      },
    ];

    const tools = extractToolsUsed(messages);
    assert.equal(tools.size, 1);
    assert.ok(tools.has("Read"));
  });

  it("extracts multiple tool names", () => {
    const messages: ParsedMessage[] = [
      {
        role: "assistant",
        content: "",
        tokens: 50,
        contentBlocks: [
          { type: "tool_use", id: "1", name: "Read", input: {} },
          { type: "tool_use", id: "2", name: "Write", input: {} },
          { type: "tool_use", id: "3", name: "Bash", input: {} },
        ],
      },
    ];

    const tools = extractToolsUsed(messages);
    assert.equal(tools.size, 3);
    assert.ok(tools.has("Read"));
    assert.ok(tools.has("Write"));
    assert.ok(tools.has("Bash"));
  });

  it("deduplicates tool names", () => {
    const messages: ParsedMessage[] = [
      {
        role: "assistant",
        content: "",
        tokens: 20,
        contentBlocks: [{ type: "tool_use", id: "1", name: "Read", input: {} }],
      },
      {
        role: "assistant",
        content: "",
        tokens: 20,
        contentBlocks: [{ type: "tool_use", id: "2", name: "Read", input: {} }],
      },
    ];

    const tools = extractToolsUsed(messages);
    assert.equal(tools.size, 1);
    assert.ok(tools.has("Read"));
  });

  it("returns empty set for messages without tool_use blocks", () => {
    const messages: ParsedMessage[] = [
      {
        role: "user",
        content: "Hello",
        tokens: 5,
        contentBlocks: [{ type: "text", text: "Hello" }],
      },
      {
        role: "assistant",
        content: "Hi there",
        tokens: 5,
        contentBlocks: [{ type: "text", text: "Hi there" }],
      },
    ];

    const tools = extractToolsUsed(messages);
    assert.equal(tools.size, 0);
  });

  it("handles messages without contentBlocks", () => {
    const messages: ParsedMessage[] = [
      {
        role: "user",
        content: "Hello",
        tokens: 5,
        contentBlocks: null,
      },
    ];

    const tools = extractToolsUsed(messages);
    assert.equal(tools.size, 0);
  });

  it("ignores blocks without name field", () => {
    const messages: ParsedMessage[] = [
      {
        role: "assistant",
        content: "",
        tokens: 20,
        contentBlocks: [
          { type: "tool_use", id: "1", name: "Read", input: {} },
          { type: "text", text: "some text" } as any,
        ],
      },
    ];

    const tools = extractToolsUsed(messages);
    assert.equal(tools.size, 1);
    assert.ok(tools.has("Read"));
  });
});
