import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseContextInfo } from "../src/core.js";
import { Store } from "../src/server/store.js";
import type { ResponseData } from "../src/types.js";

function makeStore(opts?: Partial<{ maxSessions: number }>): {
  store: Store;
  dir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "context-lens-test-"));
  const store = new Store({
    dataDir: path.join(dir, "data"),
    stateFile: path.join(dir, "data", "state.jsonl"),
    maxSessions: opts?.maxSessions ?? 10,
    maxCompactMessages: 2,
  });
  return {
    store,
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

describe("Store", () => {
  it("groups turns into one conversation when session ID is stable", () => {
    const { store, cleanup } = makeStore();

    const sessionId = "session_44444444-4444-4444-4444-444444444444";
    const body1 = {
      model: "claude-sonnet-4",
      metadata: { user_id: sessionId },
      messages: [{ role: "user", content: "first prompt" }],
    };
    const body2 = {
      model: "claude-sonnet-4",
      metadata: { user_id: sessionId },
      messages: [{ role: "user", content: "second prompt with different text" }],
    };

    const ci1 = parseContextInfo("anthropic", body1, "anthropic-messages");
    const ci2 = parseContextInfo("anthropic", body2, "anthropic-messages");

    const e1 = store.storeRequest(
      ci1,
      {
        model: "claude-sonnet-4",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 3 },
      } as any,
      "claude",
      body1,
    );
    const e2 = store.storeRequest(
      ci2,
      {
        model: "claude-sonnet-4",
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 4 },
      } as any,
      "claude",
      body2,
    );

    assert.ok(e1.conversationId, "first turn should be grouped");
    assert.equal(e2.conversationId, e1.conversationId);
    assert.equal(store.getConversations().size, 1);
    assert.equal(store.getCapturedRequests().length, 2);

    cleanup();
  });

  it("groups responses turns using previous_response_id chaining", () => {
    const { store, cleanup } = makeStore();

    const body1 = {
      model: "gpt-4o",
      input: [{ role: "user", content: "first turn" }],
    };
    const body2 = {
      model: "gpt-4o",
      previous_response_id: "resp_abc",
      input: [{ role: "user", content: "follow-up turn" }],
    };

    const ci1 = parseContextInfo("openai", body1, "responses");
    const ci2 = parseContextInfo("openai", body2, "responses");

    const e1 = store.storeRequest(
      ci1,
      {
        id: "resp_abc",
        model: "gpt-4o",
        usage: { prompt_tokens: 50, completion_tokens: 10 },
        choices: [{ finish_reason: "stop" }],
      } as any,
      "codex",
      body1,
    );
    const e2 = store.storeRequest(
      ci2,
      {
        id: "resp_def",
        model: "gpt-4o",
        usage: { prompt_tokens: 20, completion_tokens: 8 },
        choices: [{ finish_reason: "stop" }],
      } as any,
      "codex",
      body2,
    );

    assert.ok(e1.conversationId, "first turn should be grouped");
    assert.equal(e2.conversationId, e1.conversationId);
    assert.equal(store.getConversations().size, 1);

    cleanup();
  });

  it("uses API usage as authoritative total tokens and computes cache-aware cost", () => {
    const { store, cleanup } = makeStore();

    const body = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "x".repeat(10_000) }],
    };
    const ci = parseContextInfo("anthropic", body, "anthropic-messages");
    const entry = store.storeRequest(
      ci,
      {
        model: "claude-sonnet-4-20250514",
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100,
          output_tokens: 200,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 400,
        },
      } as any,
      "claude",
      body,
    );

    // Authoritative context total is input + cache read + cache write.
    assert.equal(entry.contextInfo.totalTokens, 1400);
    // 100*$3/M + 200*$15/M + 900*$0.3/M + 400*$0.75/M = $0.00387
    assert.equal(entry.costUsd, 0.00387);

    cleanup();
  });

  it("stores, compacts, and increments revision", async () => {
    const { store, cleanup } = makeStore();

    const body = {
      model: "claude-sonnet-4-20250514",
      metadata: { user_id: "session_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
      system: "be helpful",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "more" },
      ],
    };
    const ci = parseContextInfo("anthropic", body, "anthropic-messages");
    const resp: ResponseData = {
      model: "claude-sonnet-4-20250514",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 2 },
    } as any;

    const rev0 = store.getRevision();
    const entry = store.storeRequest(
      ci,
      resp,
      "claude",
      body,
      { httpStatus: 200 },
      { "user-agent": "claude-cli/1.0" },
    );
    assert.ok(store.getRevision() > rev0);
    assert.equal(entry.source, "claude");

    // Compaction: systemPrompts/tools are dropped, messages are capped.
    assert.equal(entry.contextInfo.systemPrompts.length, 0);
    assert.equal(entry.contextInfo.tools.length, 0);
    assert.ok(entry.contextInfo.messages.length <= 2);

    // Response is compacted to usage-only shape.
    const r = entry.response as any;
    assert.ok(r.usage);
    assert.equal(r.usage.input_tokens, 1);
    assert.equal(r.usage.output_tokens, 2);

    cleanup();
  });

  it("evicts oldest conversations when maxSessions is exceeded", async () => {
    const { store, cleanup } = makeStore({ maxSessions: 1 });

    const body1 = {
      model: "claude-sonnet-4",
      metadata: { user_id: "session_11111111-1111-1111-1111-111111111111" },
      messages: [{ role: "user", content: "one" }],
    };
    const ci1 = parseContextInfo("anthropic", body1, "anthropic-messages");
    store.storeRequest(
      ci1,
      {
        model: "claude-sonnet-4",
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      } as any,
      "claude",
      body1,
    );

    // Ensure timestamps differ.
    await new Promise((r) => setTimeout(r, 5));

    const body2 = {
      model: "claude-sonnet-4",
      metadata: { user_id: "session_22222222-2222-2222-2222-222222222222" },
      messages: [{ role: "user", content: "two" }],
    };
    const ci2 = parseContextInfo("anthropic", body2, "anthropic-messages");
    store.storeRequest(
      ci2,
      {
        model: "claude-sonnet-4",
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      } as any,
      "claude",
      body2,
    );

    assert.equal(store.getConversations().size, 1);
    const onlyConvoId = [...store.getConversations().keys()][0];
    assert.ok(onlyConvoId);

    cleanup();
  });

  it("persists state and restores compact entries via loadState()", () => {
    const { store, dir, cleanup } = makeStore();

    const body = {
      model: "claude-sonnet-4",
      metadata: { user_id: "session_33333333-3333-3333-3333-333333333333" },
      messages: [{ role: "user", content: "hi" }],
    };
    const ci = parseContextInfo("anthropic", body, "anthropic-messages");
    store.storeRequest(
      ci,
      {
        model: "claude-sonnet-4",
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      } as any,
      "claude",
      body,
    );

    const store2 = new Store({
      dataDir: path.join(dir, "data"),
      stateFile: path.join(dir, "data", "state.jsonl"),
      maxSessions: 10,
      maxCompactMessages: 60,
    });
    store2.loadState();
    assert.equal(store2.getCapturedRequests().length, 1);
    assert.ok(store2.getConversations().size >= 1);

    cleanup();
  });

  it("backfills totalTokens from OpenAI prompt/completion usage on loadState()", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "context-lens-test-"));
    const dataDir = path.join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    const stateFile = path.join(dataDir, "state.jsonl");

    const convoLine = JSON.stringify({
      type: "conversation",
      data: {
        id: "openai-convo",
        label: "openai",
        source: "codex",
        workingDirectory: null,
        firstSeen: "2026-01-01T00:00:00.000Z",
        sessionId: null,
      },
    });

    const entryLine = JSON.stringify({
      type: "entry",
      data: {
        id: 1,
        timestamp: "2026-01-01T00:00:01.000Z",
        contextInfo: {
          provider: "openai",
          apiFormat: "responses",
          model: "gpt-4o",
          systemTokens: 10,
          toolsTokens: 5,
          messagesTokens: 85,
          totalTokens: 9999, // intentionally wrong
          systemPrompts: [],
          tools: [],
          messages: [{ role: "user", content: "hello", tokens: 85, contentBlocks: null }],
        },
        response: {
          model: "gpt-4o",
          usage: { prompt_tokens: 120, completion_tokens: 30 },
          choices: [{ finish_reason: "stop" }],
        },
        contextLimit: 128_000,
        source: "codex",
        conversationId: "openai-convo",
        agentKey: null,
        agentLabel: "openai",
        httpStatus: 200,
        timings: null,
        requestBytes: 100,
        responseBytes: 100,
        targetUrl: null,
        composition: [],
        costUsd: null,
        healthScore: null,
        securityAlerts: [],
        usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 },
        responseModel: null,
        stopReason: null,
      },
    });

    writeFileSync(stateFile, convoLine + "\n" + entryLine + "\n");

    const store = new Store({
      dataDir,
      stateFile,
      maxSessions: 10,
      maxCompactMessages: 60,
    });
    store.loadState();

    const ci = store.getCapturedRequests()[0].contextInfo;
    assert.equal(ci.totalTokens, 120); // prompt only; completion is output, not context window input

    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  it("backfills totalTokens from Gemini usageMetadata on loadState()", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "context-lens-test-"));
    const dataDir = path.join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    const stateFile = path.join(dataDir, "state.jsonl");

    const convoLine = JSON.stringify({
      type: "conversation",
      data: {
        id: "gemini-convo",
        label: "gemini",
        source: "gemini",
        workingDirectory: null,
        firstSeen: "2026-01-01T00:00:00.000Z",
        sessionId: null,
      },
    });

    const entryLine = JSON.stringify({
      type: "entry",
      data: {
        id: 1,
        timestamp: "2026-01-01T00:00:01.000Z",
        contextInfo: {
          provider: "gemini",
          apiFormat: "gemini",
          model: "gemini-2.0-flash",
          systemTokens: 20,
          toolsTokens: 10,
          messagesTokens: 70,
          totalTokens: 7777, // intentionally wrong
          systemPrompts: [],
          tools: [],
          messages: [{ role: "user", content: "hello", tokens: 70, contentBlocks: null }],
        },
        response: {
          modelVersion: "gemini-2.0-flash",
          usageMetadata: {
            promptTokenCount: 200,
            candidatesTokenCount: 40,
            cachedContentTokenCount: 50,
          },
          candidates: [{ finishReason: "STOP" }],
        },
        contextLimit: 1_048_576,
        source: "gemini",
        conversationId: "gemini-convo",
        agentKey: null,
        agentLabel: "gemini",
        httpStatus: 200,
        timings: null,
        requestBytes: 100,
        responseBytes: 100,
        targetUrl: null,
        composition: [],
        costUsd: null,
        healthScore: null,
        securityAlerts: [],
        usage: { inputTokens: 200, outputTokens: 40, cacheReadTokens: 50, cacheWriteTokens: 0 },
        responseModel: null,
        stopReason: null,
      },
    });

    writeFileSync(stateFile, convoLine + "\n" + entryLine + "\n");

    const store = new Store({
      dataDir,
      stateFile,
      maxSessions: 10,
      maxCompactMessages: 60,
    });
    store.loadState();

    const ci = store.getCapturedRequests()[0].contextInfo;
    assert.equal(ci.totalTokens, 250); // prompt + cached content

    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  it("migrates inflated image token counts on loadState()", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "context-lens-test-"));
    const dataDir = path.join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    const stateFile = path.join(dataDir, "state.jsonl");

    // Write a state file with an entry that has inflated image token counts
    // (simulating pre-fix persisted data)
    const convoLine = JSON.stringify({
      type: "conversation",
      data: {
        id: "test-convo",
        label: "test",
        source: "claude",
        workingDirectory: null,
        firstSeen: "2026-01-01T00:00:00.000Z",
        sessionId: null,
      },
    });

    const entryLine = JSON.stringify({
      type: "entry",
      data: {
        id: 1,
        timestamp: "2026-01-01T00:00:01.000Z",
        contextInfo: {
          provider: "anthropic",
          apiFormat: "anthropic-messages",
          model: "claude-sonnet-4",
          systemTokens: 100,
          toolsTokens: 50,
          // Inflated: 750,000 tokens from a 3MB base64 image
          messagesTokens: 750_100,
          totalTokens: 750_250,
          systemPrompts: [],
          tools: [],
          messages: [
            { role: "user", content: "hello", tokens: 2, contentBlocks: null },
            {
              role: "user",
              content: "[{\"type\":\"tool_result\"...",
              // Inflated token count from base64 image
              tokens: 750_000,
              contentBlocks: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_123",
                  content: [
                    { type: "text", text: "Read image file [image/png]" },
                    { type: "image" },
                  ],
                },
              ],
            },
            { role: "assistant", content: "I see an image", tokens: 4, contentBlocks: null },
          ],
        },
        response: { usage: { input_tokens: 100, output_tokens: 50 } },
        contextLimit: 200_000,
        source: "claude",
        conversationId: "test-convo",
        agentKey: null,
        agentLabel: "test",
        httpStatus: 200,
        timings: null,
        requestBytes: 100,
        responseBytes: 100,
        targetUrl: null,
        composition: [],
        costUsd: null,
        healthScore: null,
        securityAlerts: [],
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
        responseModel: null,
        stopReason: null,
      },
    });

    writeFileSync(stateFile, convoLine + "\n" + entryLine + "\n");

    const store = new Store({
      dataDir,
      stateFile,
      maxSessions: 10,
      maxCompactMessages: 60,
    });
    store.loadState();

    const entries = store.getCapturedRequests();
    assert.equal(entries.length, 1);

    const ci = entries[0].contextInfo;
    // The image message should now have ~1,600 tokens (fixed estimate), not 750,000
    const imageMsg = ci.messages[1];
    assert.ok(
      imageMsg.tokens < 5_000,
      `Expected image msg tokens <5,000 but got ${imageMsg.tokens}`,
    );
    // Non-image messages should be unchanged
    assert.equal(ci.messages[0].tokens, 2);
    assert.equal(ci.messages[2].tokens, 4);
    // Totals should be recalculated
    assert.ok(
      ci.messagesTokens < 10_000,
      `Expected messagesTokens <10,000 but got ${ci.messagesTokens}`,
    );
    assert.ok(
      ci.totalTokens < 10_200,
      `Expected totalTokens <10,200 but got ${ci.totalTokens}`,
    );
    // systemTokens and toolsTokens should be unchanged
    assert.equal(ci.systemTokens, 100);
    assert.equal(ci.toolsTokens, 50);

    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  it("fixes messagesTokens mismatch when image messages were truncated", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "context-lens-test-"));
    const dataDir = path.join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    const stateFile = path.join(dataDir, "state.jsonl");

    // Simulate: images were in earlier messages that got truncated during compaction.
    // The remaining messages have no image blocks, but messagesTokens is still
    // inflated from the original full set.
    const convoLine = JSON.stringify({
      type: "conversation",
      data: {
        id: "test-convo-trunc",
        label: "truncated images",
        source: "claude",
        workingDirectory: null,
        firstSeen: "2026-01-01T00:00:00.000Z",
        sessionId: null,
      },
    });

    const entryLine = JSON.stringify({
      type: "entry",
      data: {
        id: 1,
        timestamp: "2026-01-01T00:00:01.000Z",
        contextInfo: {
          provider: "anthropic",
          apiFormat: "anthropic-messages",
          model: "claude-sonnet-4",
          systemTokens: 100,
          toolsTokens: 50,
          // Inflated: includes tokens from truncated image messages
          messagesTokens: 7_000_000,
          totalTokens: 7_000_150,
          systemPrompts: [],
          tools: [],
          messages: [
            { role: "user", content: "hello", tokens: 2, contentBlocks: null },
            { role: "assistant", content: "hi there", tokens: 3, contentBlocks: null },
          ],
        },
        response: { usage: { input_tokens: 100, output_tokens: 50 } },
        contextLimit: 200_000,
        source: "claude",
        conversationId: "test-convo-trunc",
        agentKey: null,
        agentLabel: "truncated images",
        httpStatus: 200,
        timings: null,
        requestBytes: 100,
        responseBytes: 100,
        targetUrl: null,
        composition: [],
        costUsd: null,
        healthScore: null,
        securityAlerts: [],
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
        responseModel: null,
        stopReason: null,
      },
    });

    writeFileSync(stateFile, convoLine + "\n" + entryLine + "\n");

    const store = new Store({
      dataDir,
      stateFile,
      maxSessions: 10,
      maxCompactMessages: 60,
    });
    store.loadState();

    const ci = store.getCapturedRequests()[0].contextInfo;
    // messagesTokens should now match sum of per-message tokens (2 + 3 = 5)
    assert.equal(ci.messagesTokens, 5);
    assert.equal(ci.totalTokens, 155); // 100 + 50 + 5

    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  it("does not modify entries without image blocks during migration", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "context-lens-test-"));
    const dataDir = path.join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    const stateFile = path.join(dataDir, "state.jsonl");

    const convoLine = JSON.stringify({
      type: "conversation",
      data: {
        id: "test-convo-2",
        label: "text only",
        source: "claude",
        workingDirectory: null,
        firstSeen: "2026-01-01T00:00:00.000Z",
        sessionId: null,
      },
    });

    const entryLine = JSON.stringify({
      type: "entry",
      data: {
        id: 1,
        timestamp: "2026-01-01T00:00:01.000Z",
        contextInfo: {
          provider: "anthropic",
          apiFormat: "anthropic-messages",
          model: "claude-sonnet-4",
          systemTokens: 100,
          toolsTokens: 50,
          messagesTokens: 25,
          totalTokens: 175,
          systemPrompts: [],
          tools: [],
          messages: [
            { role: "user", content: "hello there friend", tokens: 5, contentBlocks: null },
            { role: "assistant", content: "hi back to you my friend", tokens: 7, contentBlocks: null },
            {
              role: "user",
              content: "tool result text",
              tokens: 13,
              contentBlocks: [
                { type: "tool_result", tool_use_id: "t1", content: "some tool output text here" },
              ],
            },
          ],
        },
        response: { usage: { input_tokens: 175, output_tokens: 20 } },
        contextLimit: 200_000,
        source: "claude",
        conversationId: "test-convo-2",
        agentKey: null,
        agentLabel: "text only",
        httpStatus: 200,
        timings: null,
        requestBytes: 100,
        responseBytes: 100,
        targetUrl: null,
        composition: [],
        costUsd: null,
        healthScore: null,
        securityAlerts: [],
        usage: { inputTokens: 175, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        responseModel: null,
        stopReason: null,
      },
    });

    writeFileSync(stateFile, convoLine + "\n" + entryLine + "\n");

    const store = new Store({
      dataDir,
      stateFile,
      maxSessions: 10,
      maxCompactMessages: 60,
    });
    store.loadState();

    const ci = store.getCapturedRequests()[0].contextInfo;
    // All token counts should be untouched
    assert.equal(ci.messages[0].tokens, 5);
    assert.equal(ci.messages[1].tokens, 7);
    assert.equal(ci.messages[2].tokens, 13);
    assert.equal(ci.messagesTokens, 25);
    assert.equal(ci.totalTokens, 175);

    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
});
