import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { detectSource, parseContextInfo } from "../src/core.js";
import {
  anthropicBasic,
  claudeSession,
  openaiChat,
} from "./helpers/fixtures.js";

describe("detectSource", () => {
  it("returns existing source if already tagged", () => {
    const info = parseContextInfo(
      "anthropic",
      anthropicBasic,
      "anthropic-messages",
    );
    assert.equal(detectSource(info, "my-tool"), "my-tool");
  });

  it("detects from headers (primary)", () => {
    const info = parseContextInfo(
      "openai",
      { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      "chat-completions",
    );
    const source = detectSource(info, null, {
      "user-agent": "claude-cli/1.2.3",
    });
    assert.equal(source, "claude");
  });

  it("detects aider from system prompt", () => {
    const info = parseContextInfo("openai", openaiChat, "chat-completions");
    const source = detectSource(info, null);
    assert.equal(source, "aider");
  });

  it("detects claude from system prompt", () => {
    const info = parseContextInfo(
      "anthropic",
      claudeSession,
      "anthropic-messages",
    );
    const source = detectSource(info, null);
    assert.equal(source, "claude");
  });

  it('passes through "unknown" source to allow auto-detection', () => {
    const info = parseContextInfo("openai", openaiChat, "chat-completions");
    const source = detectSource(info, "unknown");
    assert.equal(source, "aider"); // auto-detected from system prompt
  });

  it('returns "unknown" when no signature matches', () => {
    const info = parseContextInfo(
      "anthropic",
      anthropicBasic,
      "anthropic-messages",
    );
    const source = detectSource(info, null);
    assert.equal(source, "unknown");
  });
});
