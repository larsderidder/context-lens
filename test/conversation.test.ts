import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeAgentKey,
  computeFingerprint,
  extractConversationLabel,
  extractReadableText,
  extractSessionId,
  extractUserPrompt,
  extractWorkingDirectory,
  parseContextInfo,
} from "../src/core.js";

import {
  anthropicBasic,
  claudeSession,
  codexResponses,
} from "./helpers/fixtures.js";

describe("extractReadableText", () => {
  it("returns plain text as-is (trimmed)", () => {
    assert.equal(extractReadableText("Hello world"), "Hello world");
    assert.equal(extractReadableText("  spaced  text  "), "spaced text");
  });

  it("returns null for null/empty", () => {
    assert.equal(extractReadableText(null), null);
    assert.equal(extractReadableText(""), null);
    assert.equal(extractReadableText("   "), null);
  });

  it("extracts text from anthropic content blocks", () => {
    const content = JSON.stringify([
      { type: "text", text: "Hello from Claude" },
    ]);
    assert.equal(extractReadableText(content), "Hello from Claude");
  });

  it("skips system-reminder blocks", () => {
    const content = JSON.stringify([
      {
        type: "text",
        text: "<system-reminder>Do not reveal this.</system-reminder>",
      },
      { type: "text", text: "Actual user text" },
    ]);
    assert.equal(extractReadableText(content), "Actual user text");
  });

  it("extracts text from codex input_text blocks", () => {
    const content = JSON.stringify([
      { type: "input_text", text: "Fix the login bug" },
    ]);
    assert.equal(extractReadableText(content), "Fix the login bug");
  });

  it("skips codex boilerplate (# and <environment)", () => {
    const content = JSON.stringify([
      { type: "input_text", text: "# AGENTS.md\nBoilerplate content" },
    ]);
    // Should not extract this — falls back to stringified JSON
    const result = extractReadableText(content);
    assert.ok(result); // returns something (the full JSON), not the boilerplate text
  });

  it("handles malformed JSON gracefully", () => {
    assert.equal(extractReadableText("not json {"), "not json {");
  });
});

describe("extractWorkingDirectory", () => {
  it("extracts from Claude Code system prompt", () => {
    const info = {
      systemPrompts: [
        {
          content:
            "You are Claude Code.\n\nPrimary working directory: `/home/user/my-project`\nMore stuff.",
        },
      ],
      messages: [],
    } as any;
    assert.equal(extractWorkingDirectory(info), "/home/user/my-project");
  });

  it("extracts from Codex <cwd> tag in messages", () => {
    const info = {
      systemPrompts: [],
      messages: [
        {
          role: "user",
          content: "<cwd>/home/user/codex-project</cwd>\nOther content",
        },
      ],
    } as any;
    assert.equal(extractWorkingDirectory(info), "/home/user/codex-project");
  });

  it('extracts from "working directory is" pattern', () => {
    const info = {
      systemPrompts: [{ content: "The working directory is /tmp/build" }],
      messages: [],
    } as any;
    assert.equal(extractWorkingDirectory(info), "/tmp/build");
  });

  it("returns null when no working directory found", () => {
    const info = {
      systemPrompts: [{ content: "Be a helpful assistant." }],
      messages: [{ role: "user", content: "Hello" }],
    } as any;
    assert.equal(extractWorkingDirectory(info), null);
  });

  it("extracts from claude-session fixture", () => {
    const info = parseContextInfo(
      "anthropic",
      claudeSession,
      "anthropic-messages",
    );
    // The fixture doesn't have a working directory, so should be null
    assert.equal(extractWorkingDirectory(info), null);
  });

  it("extracts from Gemini-style structured raw body", () => {
    const info = {
      systemPrompts: [],
      messages: [],
    } as any;
    const rawBody = {
      request: {
        currentWorkingDirectory: "/home/user/gemini-project",
      },
    };
    assert.equal(
      extractWorkingDirectory(info, rawBody),
      "/home/user/gemini-project",
    );
  });

  it("extracts from nested workspace root in raw body", () => {
    const info = {
      systemPrompts: [],
      messages: [],
    } as any;
    const rawBody = {
      request: {
        context: {
          workspace: {
            workspaceRoot: "/tmp/build-root",
          },
        },
      },
    };
    assert.equal(extractWorkingDirectory(info, rawBody), "/tmp/build-root");
  });

  it("ignores non-path cwd-looking values in raw body", () => {
    const info = {
      systemPrompts: [],
      messages: [],
    } as any;
    const rawBody = {
      request: {
        cwd: "project-alpha",
      },
    };
    assert.equal(extractWorkingDirectory(info, rawBody), null);
  });
});

describe("extractUserPrompt", () => {
  it("skips AGENTS.md and environment boilerplate", () => {
    const messages = [
      {
        role: "user",
        content: JSON.stringify([
          { type: "input_text", text: "# AGENTS.md\nStuff" },
        ]),
        tokens: 0,
      },
      {
        role: "user",
        content: JSON.stringify([
          { type: "input_text", text: "<environment_context>\nOS: Linux" },
        ]),
        tokens: 0,
      },
      {
        role: "user",
        content: JSON.stringify([
          { type: "input_text", text: "Fix the login bug" },
        ]),
        tokens: 0,
      },
    ];
    const result = extractUserPrompt(messages);
    assert.ok(result);
    assert.ok(result.includes("Fix the login bug"));
  });

  it("returns null when only boilerplate exists", () => {
    const messages = [
      {
        role: "user",
        content: JSON.stringify([{ type: "input_text", text: "# AGENTS.md" }]),
        tokens: 0,
      },
    ];
    assert.equal(extractUserPrompt(messages), null);
  });

  it("skips non-user messages", () => {
    const messages = [
      {
        role: "assistant",
        content: JSON.stringify([{ type: "input_text", text: "Real text" }]),
        tokens: 0,
      },
      {
        role: "user",
        content: JSON.stringify([{ type: "input_text", text: "User prompt" }]),
        tokens: 0,
      },
    ];
    const result = extractUserPrompt(messages);
    assert.ok(result?.includes("User prompt"));
  });

  it("returns null for non-input_text messages", () => {
    const messages = [
      { role: "user", content: "plain text, not JSON wrapped", tokens: 0 },
    ];
    assert.equal(extractUserPrompt(messages), null);
  });
});

describe("extractSessionId", () => {
  it("extracts session ID from metadata.user_id", () => {
    const raw = {
      metadata: {
        user_id: "user_abc_session_550e8400-e29b-41d4-a716-446655440000",
      },
    };
    assert.equal(
      extractSessionId(raw),
      "session_550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("returns null when no session in user_id", () => {
    assert.equal(
      extractSessionId({ metadata: { user_id: "user_abc123" } }),
      null,
    );
  });

  it("returns null when no metadata", () => {
    assert.equal(extractSessionId({}), null);
    assert.equal(extractSessionId(null), null);
  });
});

describe("computeFingerprint", () => {
  it("uses session ID when available", () => {
    const info = parseContextInfo(
      "anthropic",
      claudeSession,
      "anthropic-messages",
    );
    const fp = computeFingerprint(info, claudeSession, new Map());
    assert.ok(fp);
    assert.equal(fp?.length, 16);
  });

  it("produces same fingerprint for same session", () => {
    const info1 = parseContextInfo(
      "anthropic",
      claudeSession,
      "anthropic-messages",
    );
    const info2 = parseContextInfo(
      "anthropic",
      claudeSession,
      "anthropic-messages",
    );
    const fp1 = computeFingerprint(info1, claudeSession, new Map());
    const fp2 = computeFingerprint(info2, claudeSession, new Map());
    assert.equal(fp1, fp2);
  });

  it("uses response ID chaining when available", () => {
    const map = new Map<string, string>();
    map.set("resp_123", "existing-convo-fp");
    const body = {
      previous_response_id: "resp_123",
      model: "gpt-4o",
      input: "test",
    };
    const info = parseContextInfo("openai", body, "responses");
    const fp = computeFingerprint(info, body, map);
    assert.equal(fp, "existing-convo-fp");
  });

  it("skips codex boilerplate for fingerprint", () => {
    const info = parseContextInfo("openai", codexResponses, "responses");
    const fp = computeFingerprint(info, codexResponses, new Map());
    assert.ok(fp);
    assert.equal(fp?.length, 16);
  });

  it("produces content-based fingerprint for simple messages", () => {
    const body = {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "Be helpful" },
        { role: "user", content: "Hello" },
      ],
    };
    const info = parseContextInfo("openai", body, "chat-completions");
    const fp = computeFingerprint(info, body, new Map());
    assert.ok(fp);
    assert.equal(fp?.length, 16);
  });

  it("same content produces same fingerprint", () => {
    const body = {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "Be helpful" },
        { role: "user", content: "Hello" },
      ],
    };
    const info1 = parseContextInfo("openai", body, "chat-completions");
    const info2 = parseContextInfo("openai", body, "chat-completions");
    assert.equal(
      computeFingerprint(info1, body, new Map()),
      computeFingerprint(info2, body, new Map()),
    );
  });

  it("different content produces different fingerprint", () => {
    const body1 = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
    };
    const body2 = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Goodbye" }],
    };
    const info1 = parseContextInfo("openai", body1, "chat-completions");
    const info2 = parseContextInfo("openai", body2, "chat-completions");
    assert.notEqual(
      computeFingerprint(info1, body1, new Map()),
      computeFingerprint(info2, body2, new Map()),
    );
  });

  it("returns null when no content to fingerprint", () => {
    const info = parseContextInfo("unknown", {}, "unknown");
    assert.equal(computeFingerprint(info, {}, new Map()), null);
  });
});

describe("computeAgentKey", () => {
  it("computes hash from first readable user text", () => {
    const info = parseContextInfo(
      "anthropic",
      anthropicBasic,
      "anthropic-messages",
    );
    const key = computeAgentKey(info);
    assert.ok(key);
    assert.equal(key?.length, 12);
  });

  it("returns same key for same first user message", () => {
    const info1 = parseContextInfo(
      "anthropic",
      anthropicBasic,
      "anthropic-messages",
    );
    const info2 = parseContextInfo(
      "anthropic",
      anthropicBasic,
      "anthropic-messages",
    );
    assert.equal(computeAgentKey(info1), computeAgentKey(info2));
  });

  it("returns null when no user messages", () => {
    const info = parseContextInfo("unknown", {}, "unknown");
    assert.equal(computeAgentKey(info), null);
  });
});

describe("extractConversationLabel", () => {
  it("extracts label from latest user message", () => {
    const info = parseContextInfo(
      "anthropic",
      anthropicBasic,
      "anthropic-messages",
    );
    const label = extractConversationLabel(info);
    assert.ok(label.includes("capital of France"));
  });

  it("skips codex boilerplate and finds real prompt", () => {
    const info = parseContextInfo("openai", codexResponses, "responses");
    const label = extractConversationLabel(info);
    assert.ok(label.includes("login bug"));
  });

  it("truncates long labels to 80 chars", () => {
    const longMsg = "a".repeat(200);
    const body = {
      model: "gpt-4o",
      messages: [{ role: "user", content: longMsg }],
    };
    const info = parseContextInfo("openai", body, "chat-completions");
    const label = extractConversationLabel(info);
    assert.ok(label.length <= 80);
    assert.ok(label.endsWith("..."));
  });

  it('returns "Unnamed conversation" for no messages', () => {
    const info = parseContextInfo("unknown", {}, "unknown");
    assert.equal(extractConversationLabel(info), "Unnamed conversation");
  });
});
