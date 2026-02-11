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
        response: { usage: { input_tokens: 50, output_tokens: 20 } },
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
        usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
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
