import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { projectEntry } from "../src/server/projection.js";
import type { CapturedEntry, ContextInfo, ResponseData } from "../src/types.js";

function makeContextInfo(overrides?: Partial<ContextInfo>): ContextInfo {
  return {
    provider: "anthropic",
    apiFormat: "anthropic-messages",
    model: "claude-sonnet-4-20250514",
    systemTokens: 100,
    toolsTokens: 50,
    messagesTokens: 200,
    totalTokens: 350,
    systemPrompts: [],
    tools: [],
    messages: [{ role: "user", content: "hello", tokens: 2 }],
    ...overrides,
  };
}

function makeEntry(overrides?: Partial<CapturedEntry>): CapturedEntry {
  return {
    id: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    contextInfo: makeContextInfo(),
    response: {
      model: "claude-sonnet-4-20250514",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 350,
        output_tokens: 42,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 0,
      },
    } as ResponseData,
    contextLimit: 200000,
    source: "claude",
    conversationId: "abc123",
    agentKey: "agent1",
    agentLabel: "Main agent",
    httpStatus: 200,
    timings: null,
    requestBytes: 1024,
    responseBytes: 2048,
    targetUrl: "https://api.anthropic.com/v1/messages",
    requestHeaders: {},
    responseHeaders: {},
    composition: [{ category: "user_text", tokens: 200, pct: 57.1, count: 1 }],
    costUsd: 0.005,
    healthScore: { overall: 85, rating: "good", audits: [] },
    securityAlerts: [],
    ...overrides,
  };
}

describe("projectEntry", () => {
  it("projects all fields from a captured entry", () => {
    const entry = makeEntry();
    const result = projectEntry(entry, entry.contextInfo);

    assert.equal(result.id, 1);
    assert.equal(result.timestamp, "2026-01-01T00:00:00.000Z");
    assert.equal(result.source, "claude");
    assert.equal(result.conversationId, "abc123");
    assert.equal(result.agentKey, "agent1");
    assert.equal(result.agentLabel, "Main agent");
    assert.equal(result.httpStatus, 200);
    assert.equal(result.requestBytes, 1024);
    assert.equal(result.responseBytes, 2048);
    assert.equal(result.targetUrl, "https://api.anthropic.com/v1/messages");
    assert.equal(result.contextLimit, 200000);
    assert.equal(result.costUsd, 0.005);
    assert.deepEqual(result.composition, entry.composition);
    assert.deepEqual(result.healthScore, entry.healthScore);
  });

  it("extracts usage from response.usage", () => {
    const entry = makeEntry();
    const result = projectEntry(entry, entry.contextInfo);

    assert.ok(result.usage);
    const usage = result.usage;
    assert.equal(usage?.inputTokens, 350);
    assert.equal(usage?.outputTokens, 42);
    assert.equal(usage?.cacheReadTokens, 100);
    assert.equal(usage?.cacheWriteTokens, 0);
  });

  it("extracts responseModel and stopReason", () => {
    const entry = makeEntry();
    const result = projectEntry(entry, entry.contextInfo);

    assert.equal(result.responseModel, "claude-sonnet-4-20250514");
    assert.equal(result.stopReason, "end_turn");
  });

  it("returns null usage when response has no usage field", () => {
    const entry = makeEntry({ response: { raw: true } });
    const result = projectEntry(entry, entry.contextInfo);

    assert.equal(result.usage, null);
    assert.equal(result.responseModel, null);
    assert.equal(result.stopReason, null);
  });

  it("returns null usage for streaming responses", () => {
    const entry = makeEntry({
      response: { streaming: true, chunks: "data: {}\n\n" },
    });
    const result = projectEntry(entry, entry.contextInfo);

    assert.equal(result.usage, null);
  });

  it("uses the provided contextInfo, not the entry's own", () => {
    const entry = makeEntry();
    const compactedCI = makeContextInfo({
      systemPrompts: [],
      tools: [],
      messages: [],
      totalTokens: 999,
    });
    const result = projectEntry(entry, compactedCI);

    assert.equal(result.contextInfo.totalTokens, 999);
    assert.equal(result.contextInfo.messages.length, 0);
  });

  it("handles null conversationId and agentKey", () => {
    const entry = makeEntry({ conversationId: null, agentKey: null });
    const result = projectEntry(entry, entry.contextInfo);

    assert.equal(result.conversationId, null);
    assert.equal(result.agentKey, null);
  });

  it("handles null healthScore", () => {
    const entry = makeEntry({ healthScore: null });
    const result = projectEntry(entry, entry.contextInfo);

    assert.equal(result.healthScore, null);
  });
});
