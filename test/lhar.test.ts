import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { parseContextInfo } from "../src/core.js";
import {
  analyzeComposition,
  buildLharRecord,
  buildSessionLine,
  parseResponseUsage,
  redactHeaders,
  toLharJson,
  toLharJsonl,
} from "../src/lhar.js";
import type { CapturedEntry, Conversation } from "../src/types.js";

const fixturesDir = join(process.cwd(), "test", "fixtures");
const anthropicBasic = JSON.parse(
  readFileSync(join(fixturesDir, "anthropic-basic.json"), "utf-8"),
);
const claudeSession = JSON.parse(
  readFileSync(join(fixturesDir, "claude-session.json"), "utf-8"),
);

function makeEntry(overrides: Partial<CapturedEntry> = {}): CapturedEntry {
  const ci = parseContextInfo(
    "anthropic",
    anthropicBasic,
    "anthropic-messages",
  );
  return {
    id: Date.now(),
    timestamp: "2026-02-08T12:00:00.000Z",
    contextInfo: ci,
    response: {
      usage: { input_tokens: 1000, output_tokens: 200 },
      model: "claude-sonnet-4-20250514",
      stop_reason: "end_turn",
    },
    contextLimit: 200000,
    source: "claude",
    conversationId: "test-convo-1",
    agentKey: null,
    agentLabel: "test",
    httpStatus: 200,
    timings: {
      send_ms: 10,
      wait_ms: 10,
      receive_ms: 500,
      total_ms: 510,
      tokens_per_second: null,
    },
    requestBytes: 4096,
    responseBytes: 1024,
    targetUrl: "https://api.anthropic.com/v1/messages",
    requestHeaders: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    responseHeaders: { "x-ratelimit-limit-tokens": "100000" },
    rawBody: anthropicBasic,
    composition: analyzeComposition(ci, anthropicBasic),
    costUsd: null,
    healthScore: null,
    securityAlerts: [],
    ...overrides,
  };
}

// --- analyzeComposition ---

describe("analyzeComposition", () => {
  it("classifies anthropic message blocks", () => {
    const ci = parseContextInfo(
      "anthropic",
      claudeSession,
      "anthropic-messages",
    );
    const comp = analyzeComposition(ci, claudeSession);

    const categories = comp.map((c) => c.category);
    assert.ok(
      categories.includes("system_prompt"),
      "should have system_prompt",
    );
    assert.ok(
      categories.includes("system_injections"),
      "should have system_injections",
    );
    assert.ok(categories.includes("tool_calls"), "should have tool_calls");
    assert.ok(categories.includes("tool_results"), "should have tool_results");
  });

  it("classifies tool definitions separately", () => {
    const ci = parseContextInfo(
      "anthropic",
      anthropicBasic,
      "anthropic-messages",
    );
    const comp = analyzeComposition(ci, anthropicBasic);

    const toolDefs = comp.find((c) => c.category === "tool_definitions");
    assert.ok(toolDefs, "should have tool_definitions");
    assert.ok(toolDefs?.tokens > 0);
    assert.equal(toolDefs?.count, 1);
  });

  it("percentages sum to ~100", () => {
    const ci = parseContextInfo(
      "anthropic",
      anthropicBasic,
      "anthropic-messages",
    );
    const comp = analyzeComposition(ci, anthropicBasic);
    const totalPct = comp.reduce((sum, c) => sum + c.pct, 0);
    assert.ok(
      totalPct >= 99 && totalPct <= 101,
      `percentages sum to ${totalPct}`,
    );
  });

  it("sorted by tokens descending", () => {
    const ci = parseContextInfo(
      "anthropic",
      claudeSession,
      "anthropic-messages",
    );
    const comp = analyzeComposition(ci, claudeSession);
    for (let i = 1; i < comp.length; i++) {
      assert.ok(
        comp[i].tokens <= comp[i - 1].tokens,
        "should be sorted by tokens desc",
      );
    }
  });

  it("handles body with no messages gracefully", () => {
    const ci = parseContextInfo(
      "anthropic",
      { model: "test" },
      "anthropic-messages",
    );
    const comp = analyzeComposition(ci, { model: "test" });
    assert.ok(Array.isArray(comp));
  });

  it("falls back to contextInfo when rawBody is undefined", () => {
    const ci = parseContextInfo(
      "anthropic",
      anthropicBasic,
      "anthropic-messages",
    );
    const comp = analyzeComposition(ci, undefined);
    assert.ok(comp.length > 0);
    const systemEntry = comp.find((c) => c.category === "system_prompt");
    assert.ok(
      systemEntry,
      "should have system_prompt from contextInfo fallback",
    );
  });

  it("detects system-reminder injections", () => {
    const body = {
      model: "claude-sonnet-4",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "<system-reminder>Remember the rules.</system-reminder>",
            },
            { type: "text", text: "Hello there" },
          ],
        },
      ],
    };
    const ci = parseContextInfo("anthropic", body, "anthropic-messages");
    const comp = analyzeComposition(ci, body);
    assert.ok(
      comp.find((c) => c.category === "system_injections"),
      "should detect system injection",
    );
    assert.ok(
      comp.find((c) => c.category === "user_text"),
      "should have user_text",
    );
  });

  it("classifies thinking blocks", () => {
    const body = {
      model: "claude-sonnet-4",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Let me think about this carefully...",
            },
            { type: "text", text: "Here is my answer." },
          ],
        },
      ],
    };
    const ci = parseContextInfo("anthropic", body, "anthropic-messages");
    const comp = analyzeComposition(ci, body);
    assert.ok(
      comp.find((c) => c.category === "thinking"),
      "should have thinking",
    );
    assert.ok(
      comp.find((c) => c.category === "assistant_text"),
      "should have assistant_text",
    );
  });

  it("classifies image blocks", () => {
    const body = {
      model: "claude-sonnet-4",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", data: "abc123" } },
            { type: "text", text: "Describe this image" },
          ],
        },
      ],
    };
    const ci = parseContextInfo("anthropic", body, "anthropic-messages");
    const comp = analyzeComposition(ci, body);
    assert.ok(
      comp.find((c) => c.category === "images"),
      "should have images",
    );
  });
});

// --- parseResponseUsage ---

describe("parseResponseUsage", () => {
  it("parses Anthropic non-streaming response", () => {
    const resp = {
      model: "claude-sonnet-4-20250514",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 1500,
        output_tokens: 300,
        cache_read_input_tokens: 500,
      },
    };
    const usage = parseResponseUsage(resp);
    assert.equal(usage.inputTokens, 1500);
    assert.equal(usage.outputTokens, 300);
    assert.equal(usage.cacheReadTokens, 500);
    assert.equal(usage.model, "claude-sonnet-4-20250514");
    assert.deepEqual(usage.finishReasons, ["end_turn"]);
    assert.equal(usage.stream, false);
  });

  it("parses OpenAI non-streaming response", () => {
    const resp = {
      model: "gpt-4o",
      choices: [{ finish_reason: "stop", message: { content: "Hello" } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    };
    const usage = parseResponseUsage(resp);
    assert.equal(usage.inputTokens, 100);
    assert.equal(usage.outputTokens, 50);
    assert.deepEqual(usage.finishReasons, ["stop"]);
  });

  it("parses Anthropic streaming response", () => {
    const chunks = [
      "event: message_start",
      'data: {"type":"message_start","message":{"model":"claude-sonnet-4-20250514","usage":{"input_tokens":1000,"cache_read_input_tokens":200}}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}',
      "",
      "event: message_delta",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":150}}',
      "",
      "data: [DONE]",
    ].join("\n");
    const usage = parseResponseUsage({ streaming: true, chunks });
    assert.equal(usage.stream, true);
    assert.equal(usage.inputTokens, 1000);
    assert.equal(usage.outputTokens, 150);
    assert.equal(usage.cacheReadTokens, 200);
    assert.equal(usage.model, "claude-sonnet-4-20250514");
    assert.deepEqual(usage.finishReasons, ["end_turn"]);
  });

  it("returns zeros for null response", () => {
    const usage = parseResponseUsage(null);
    assert.equal(usage.inputTokens, 0);
    assert.equal(usage.outputTokens, 0);
    assert.equal(usage.stream, false);
  });

  it("returns zeros for raw string response", () => {
    const usage = parseResponseUsage({ raw: "not json" });
    assert.equal(usage.inputTokens, 0);
    assert.equal(usage.outputTokens, 0);
  });
});

// --- buildSessionLine ---

describe("buildSessionLine", () => {
  it("produces a valid session line", () => {
    const convo: Conversation = {
      id: "test-convo-1",
      label: "Test",
      source: "claude",
      workingDirectory: "/tmp",
      firstSeen: "2026-02-08T12:00:00Z",
    };
    const line = buildSessionLine(
      "test-convo-1",
      convo,
      "claude-sonnet-4-20250514",
    );
    assert.equal(line.type, "session");
    assert.ok(line.trace_id);
    assert.equal(line.trace_id.length, 32);
    assert.equal(line.started_at, "2026-02-08T12:00:00Z");
    assert.equal(line.tool, "claude");
    assert.equal(line.model, "claude-sonnet-4-20250514");
  });
});

// --- buildLharRecord ---

describe("buildLharRecord", () => {
  it("produces a valid LHAR record with all fields", () => {
    const entry = makeEntry();
    const record = buildLharRecord(entry, []);

    // Type discriminator
    assert.equal(record.type, "entry");

    // Identity — UUID format
    assert.ok(record.id);
    assert.match(
      record.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    assert.ok(record.trace_id);
    assert.equal(record.trace_id.length, 32);
    assert.ok(record.span_id);
    assert.equal(record.span_id.length, 16);
    assert.equal(record.parent_span_id, null);
    assert.equal(record.timestamp, "2026-02-08T12:00:00.000Z");
    assert.equal(record.sequence, 1);

    // Source
    assert.equal(record.source.tool, "claude");
    assert.equal(record.source.collector, "context-lens");
    assert.equal(record.source.agent_role, "main");

    // gen_ai
    assert.equal(record.gen_ai.system, "anthropic");
    assert.equal(record.gen_ai.request.model, "claude-sonnet-4-20250514");
    assert.equal(record.gen_ai.request.max_tokens, 1024);
    assert.equal(record.gen_ai.response.model, "claude-sonnet-4-20250514");
    assert.deepEqual(record.gen_ai.response.finish_reasons, ["end_turn"]);
    assert.equal(record.gen_ai.usage.input_tokens, 1000);
    assert.equal(record.gen_ai.usage.output_tokens, 200);

    // HTTP — url and headers
    assert.equal(record.http.method, "POST");
    assert.equal(record.http.url, "https://api.anthropic.com/v1/messages");
    assert.equal(record.http.status_code, 200);
    assert.equal(record.http.api_format, "anthropic-messages");
    assert.equal(
      record.http.request_headers["content-type"],
      "application/json",
    );
    assert.equal(
      record.http.request_headers["anthropic-version"],
      "2023-06-01",
    );
    assert.equal(
      record.http.response_headers["x-ratelimit-limit-tokens"],
      "100000",
    );

    // Timings
    assert.ok(record.timings);
    assert.equal(record.timings?.total_ms, 510);

    // Transfer
    assert.equal(record.transfer.request_bytes, 4096);
    assert.equal(record.transfer.response_bytes, 1024);

    // Context lens
    assert.equal(record.context_lens.window_size, 200000);
    assert.ok(record.context_lens.utilization >= 0);
    assert.ok(record.context_lens.composition.length > 0);
    assert.equal(
      record.context_lens.growth.cumulative_tokens,
      entry.contextInfo.totalTokens,
    );

    // Raw (privacy default)
    assert.equal(record.raw.request_body, null);
    assert.equal(record.raw.response_body, null);
  });

  it("computes consistent trace_id from conversationId", () => {
    const entry1 = makeEntry({ conversationId: "abc123" });
    const entry2 = makeEntry({ conversationId: "abc123" });
    const r1 = buildLharRecord(entry1, []);
    const r2 = buildLharRecord(entry2, []);
    assert.equal(r1.trace_id, r2.trace_id);
  });

  it("computes different trace_id for different conversations", () => {
    const entry1 = makeEntry({ conversationId: "abc123" });
    const entry2 = makeEntry({ conversationId: "xyz789" });
    const r1 = buildLharRecord(entry1, []);
    const r2 = buildLharRecord(entry2, []);
    assert.notEqual(r1.trace_id, r2.trace_id);
  });

  it("computes sequence from entries before by timestamp", () => {
    const e1 = makeEntry({
      id: 1,
      conversationId: "c1",
      timestamp: "2026-02-08T12:00:00Z",
    });
    const e2 = makeEntry({
      id: 2,
      conversationId: "c1",
      timestamp: "2026-02-08T12:01:00Z",
    });
    const e3 = makeEntry({
      id: 3,
      conversationId: "c1",
      timestamp: "2026-02-08T12:02:00Z",
    });
    const all = [e1, e2, e3];
    assert.equal(buildLharRecord(e1, all).sequence, 1); // first entry
    assert.equal(buildLharRecord(e2, all).sequence, 2); // 1 before + 1
    assert.equal(buildLharRecord(e3, all).sequence, 3); // 2 before + 1
  });

  it("detects growth from previous entries", () => {
    const e1 = makeEntry({
      id: 1,
      conversationId: "c1",
      timestamp: "2026-02-08T12:00:00Z",
    });
    const e2Info = parseContextInfo(
      "anthropic",
      {
        ...anthropicBasic,
        messages: [
          ...anthropicBasic.messages,
          { role: "user", content: "more text ".repeat(100) },
        ],
      },
      "anthropic-messages",
    );
    const e2 = makeEntry({
      id: 2,
      conversationId: "c1",
      timestamp: "2026-02-08T12:01:00Z",
      contextInfo: e2Info,
    });
    const record = buildLharRecord(e2, [e1, e2]);
    assert.ok(record.context_lens.growth.tokens_added_this_turn !== null);
    assert.ok(record.context_lens.growth.tokens_added_this_turn! > 0);
    assert.equal(record.context_lens.growth.compaction_detected, false);
  });

  it("marks subagent role when agentKey differs from majority", () => {
    // Main agent entries have agentKey "main-abc", subagent has "sub123"
    const mainEntry1 = makeEntry({
      agentKey: "main-abc",
      conversationId: "conv-1",
    });
    const mainEntry2 = makeEntry({
      agentKey: "main-abc",
      conversationId: "conv-1",
    });
    const subEntry = makeEntry({
      agentKey: "sub123",
      conversationId: "conv-1",
    });
    const allEntries = [mainEntry1, mainEntry2, subEntry];
    const record = buildLharRecord(subEntry, allEntries);
    assert.equal(record.source.agent_role, "subagent");
    // The main entries should be tagged as main
    const mainRecord = buildLharRecord(mainEntry1, allEntries);
    assert.equal(mainRecord.source.agent_role, "main");
  });

  it("handles null timings", () => {
    const entry = makeEntry({ timings: null });
    const record = buildLharRecord(entry, []);
    assert.equal(record.timings, null);
  });

  it("uses pre-computed costUsd in usage_ext.cost_usd", () => {
    const entry = makeEntry({ costUsd: 0.042 });
    const record = buildLharRecord(entry, []);
    assert.equal(record.usage_ext.cost_usd, 0.042);
  });

  it("passes null costUsd through to usage_ext.cost_usd", () => {
    const entry = makeEntry({ costUsd: null });
    const record = buildLharRecord(entry, []);
    assert.equal(record.usage_ext.cost_usd, null);
  });

  it("uses pre-computed composition instead of recomputing", () => {
    const fakeComposition = [
      { category: "system_prompt" as const, tokens: 999, pct: 100, count: 1 },
    ];
    const entry = makeEntry({ composition: fakeComposition });
    const record = buildLharRecord(entry, []);
    // Should use the fake composition, not recompute from rawBody
    assert.equal(record.context_lens.composition.length, 1);
    assert.equal(record.context_lens.composition[0].tokens, 999);
  });

  it("falls back to recomputing composition when empty", () => {
    const entry = makeEntry({ composition: [] });
    const record = buildLharRecord(entry, []);
    // Should recompute from rawBody
    assert.ok(record.context_lens.composition.length > 0);
  });

  it("excludes entries from other conversations in sequence count", () => {
    const e1 = makeEntry({
      id: 1,
      conversationId: "c1",
      timestamp: "2026-02-08T12:00:00Z",
    });
    const e2 = makeEntry({
      id: 2,
      conversationId: "c2",
      timestamp: "2026-02-08T12:01:00Z",
    });
    const e3 = makeEntry({
      id: 3,
      conversationId: "c1",
      timestamp: "2026-02-08T12:02:00Z",
    });
    const all = [e1, e2, e3];
    // e3 is in c1, only e1 is before it in c1 -> sequence 2
    assert.equal(buildLharRecord(e3, all).sequence, 2);
    // e2 is in c2, no other entries in c2 -> sequence 1
    assert.equal(buildLharRecord(e2, all).sequence, 1);
  });
});

// --- toLharJsonl ---

describe("toLharJsonl", () => {
  const convos = new Map<string, Conversation>();
  convos.set("test-convo-1", {
    id: "test-convo-1",
    label: "Test",
    source: "claude",
    workingDirectory: "/tmp",
    firstSeen: "2026-02-08T12:00:00Z",
  });

  it("produces session preamble + entry lines", () => {
    const e1 = makeEntry({ id: 1, timestamp: "2026-02-08T12:00:00Z" });
    const e2 = makeEntry({ id: 2, timestamp: "2026-02-08T12:01:00Z" });
    const jsonl = toLharJsonl([e1, e2], convos);
    const lines = jsonl.trim().split("\n");
    // 1 session preamble + 2 entries (same conversation)
    assert.equal(lines.length, 3);
    const session = JSON.parse(lines[0]);
    assert.equal(session.type, "session");
    assert.ok(session.trace_id);
    const entry1 = JSON.parse(lines[1]);
    assert.equal(entry1.type, "entry");
    assert.ok(entry1.gen_ai);
  });

  it("sorts oldest-first", () => {
    const e1 = makeEntry({ id: 1, timestamp: "2026-02-08T12:01:00Z" }); // later
    const e2 = makeEntry({ id: 2, timestamp: "2026-02-08T12:00:00Z" }); // earlier
    const jsonl = toLharJsonl([e1, e2], convos);
    const lines = jsonl.trim().split("\n");
    // Skip session line, check entry ordering
    const entries = lines.filter((l) => JSON.parse(l).type === "entry");
    const r1 = JSON.parse(entries[0]);
    const r2 = JSON.parse(entries[1]);
    assert.ok(new Date(r1.timestamp) <= new Date(r2.timestamp));
  });

  it("returns empty line for empty input", () => {
    const jsonl = toLharJsonl([], convos);
    assert.equal(jsonl, "\n");
  });

  it("emits one session line per conversation", () => {
    const convos2 = new Map<string, Conversation>();
    convos2.set("c1", {
      id: "c1",
      label: "C1",
      source: "claude",
      workingDirectory: null,
      firstSeen: "2026-02-08T12:00:00Z",
    });
    convos2.set("c2", {
      id: "c2",
      label: "C2",
      source: "claude",
      workingDirectory: null,
      firstSeen: "2026-02-08T12:00:00Z",
    });
    const e1 = makeEntry({ id: 1, conversationId: "c1" });
    const e2 = makeEntry({ id: 2, conversationId: "c1" });
    const e3 = makeEntry({ id: 3, conversationId: "c2" });
    const jsonl = toLharJsonl([e1, e2, e3], convos2);
    const lines = jsonl.trim().split("\n");
    const sessions = lines.filter((l) => JSON.parse(l).type === "session");
    assert.equal(sessions.length, 2);
  });
});

// --- toLharJson ---

describe("toLharJson", () => {
  it("produces valid wrapped structure", () => {
    const e1 = makeEntry();
    const convos = new Map<string, Conversation>();
    convos.set("test-convo-1", {
      id: "test-convo-1",
      label: "Test",
      source: "claude",
      workingDirectory: "/tmp",
      firstSeen: "2026-02-08T12:00:00Z",
    });
    const result = toLharJson([e1], convos);
    assert.ok(result.lhar);
    assert.equal(result.lhar.version, "0.1.0");
    assert.equal(result.lhar.creator.name, "context-lens");
    assert.ok(result.lhar.sessions.length > 0);
    assert.ok(result.lhar.entries.length === 1);
    assert.ok(result.lhar.entries[0].gen_ai);
  });

  it("groups sessions by trace_id", () => {
    const e1 = makeEntry({ id: 1, conversationId: "c1" });
    const e2 = makeEntry({ id: 2, conversationId: "c1" });
    const e3 = makeEntry({ id: 3, conversationId: "c2" });
    const result = toLharJson([e1, e2, e3], new Map());
    assert.equal(result.lhar.sessions.length, 2); // Two distinct trace_ids
    assert.equal(result.lhar.entries.length, 3);
  });
});

// --- redactHeaders ---

describe("redactHeaders", () => {
  it("strips all sensitive headers", () => {
    const headers: Record<string, string> = {
      authorization: "Bearer sk-secret",
      "x-api-key": "key123",
      cookie: "session=abc",
      "set-cookie": "session=abc; Path=/",
      "x-target-url": "https://api.anthropic.com",
      "proxy-authorization": "Basic xyz",
      "x-auth-token": "tok",
      "x-forwarded-authorization": "Bearer forwarded",
      "www-authenticate": 'Basic realm="test"',
      "proxy-authenticate": "Basic",
      "content-type": "application/json",
    };
    const result = redactHeaders(headers);
    assert.deepEqual(Object.keys(result), ["content-type"]);
    assert.equal(result["content-type"], "application/json");
  });

  it("is case-insensitive", () => {
    const headers = {
      Authorization: "Bearer secret",
      "X-API-KEY": "key123",
      "Content-Type": "application/json",
    };
    const result = redactHeaders(headers);
    assert.deepEqual(Object.keys(result), ["Content-Type"]);
  });

  it("does not mutate the input object", () => {
    const headers = {
      authorization: "Bearer secret",
      "content-type": "application/json",
    };
    const original = { ...headers };
    redactHeaders(headers);
    assert.deepEqual(headers, original);
  });

  it("handles empty input", () => {
    const result = redactHeaders({});
    assert.deepEqual(result, {});
  });

  it("passes through all non-sensitive headers", () => {
    const headers = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-ratelimit-limit-tokens": "100000",
    };
    const result = redactHeaders(headers);
    assert.deepEqual(result, headers);
  });
});

// --- buildLharRecord header redaction ---

describe("buildLharRecord header redaction", () => {
  it("redacts sensitive headers from LHAR output", () => {
    const entry = makeEntry({
      requestHeaders: {
        "content-type": "application/json",
        authorization: "Bearer sk-ant-secret-key",
        "x-api-key": "secret-api-key",
        "anthropic-version": "2023-06-01",
      },
      responseHeaders: {
        "x-ratelimit-limit-tokens": "100000",
        "set-cookie": "session=abc123",
      },
    });
    const record = buildLharRecord(entry, []);

    // Request headers: sensitive stripped, safe kept
    assert.equal(
      record.http.request_headers["content-type"],
      "application/json",
    );
    assert.equal(
      record.http.request_headers["anthropic-version"],
      "2023-06-01",
    );
    assert.equal(record.http.request_headers.authorization, undefined);
    assert.equal(record.http.request_headers["x-api-key"], undefined);

    // Response headers: sensitive stripped, safe kept
    assert.equal(
      record.http.response_headers["x-ratelimit-limit-tokens"],
      "100000",
    );
    assert.equal(record.http.response_headers["set-cookie"], undefined);
  });
});

// --- Privacy levels ---

describe("buildLharRecord privacy levels", () => {
  it("standard privacy: null raw bodies, redacted headers", () => {
    const entry = makeEntry({
      rawBody: anthropicBasic,
      requestHeaders: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
    });
    const record = buildLharRecord(entry, [], "standard");
    assert.equal(record.raw.request_body, null);
    assert.equal(record.raw.response_body, null);
    assert.equal(
      record.http.request_headers["content-type"],
      "application/json",
    );
    assert.equal(record.http.request_headers.authorization, undefined);
  });

  it("minimal privacy: null raw bodies, empty headers", () => {
    const entry = makeEntry({
      rawBody: anthropicBasic,
      requestHeaders: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      responseHeaders: {
        "x-ratelimit-limit-tokens": "100000",
      },
    });
    const record = buildLharRecord(entry, [], "minimal");
    assert.equal(record.raw.request_body, null);
    assert.equal(record.raw.response_body, null);
    assert.deepEqual(record.http.request_headers, {});
    assert.deepEqual(record.http.response_headers, {});
  });

  it("full privacy: includes raw request body", () => {
    const entry = makeEntry({ rawBody: anthropicBasic });
    const record = buildLharRecord(entry, [], "full");
    assert.ok(record.raw.request_body !== null);
    assert.deepEqual(record.raw.request_body, anthropicBasic);
  });

  it("full privacy: includes parsed JSON response body", () => {
    const responseData = {
      model: "claude-sonnet-4-20250514",
      stop_reason: "end_turn",
      usage: { input_tokens: 1000, output_tokens: 200 },
      content: [{ type: "text", text: "Hello world" }],
    };
    const entry = makeEntry({ response: responseData });
    const record = buildLharRecord(entry, [], "full");
    assert.ok(record.raw.response_body !== null);
    assert.deepEqual(record.raw.response_body, responseData);
  });

  it("full privacy: includes streaming response as string", () => {
    const chunks = "event: message_start\ndata: {}\n\ndata: [DONE]\n";
    const entry = makeEntry({ response: { streaming: true, chunks } });
    const record = buildLharRecord(entry, [], "full");
    assert.equal(record.raw.response_body, chunks);
  });

  it("full privacy: null request body when rawBody is undefined", () => {
    const entry = makeEntry({ rawBody: undefined });
    const record = buildLharRecord(entry, [], "full");
    assert.equal(record.raw.request_body, null);
  });

  it("full privacy: null response body for marker-only raw response", () => {
    const entry = makeEntry({ response: { raw: true } });
    const record = buildLharRecord(entry, [], "full");
    assert.equal(record.raw.response_body, null);
  });

  it("full privacy: includes raw string response body", () => {
    const entry = makeEntry({ response: { raw: "some raw text" } });
    const record = buildLharRecord(entry, [], "full");
    assert.equal(record.raw.response_body, "some raw text");
  });

  it("default privacy (no arg) behaves like standard", () => {
    const entry = makeEntry({ rawBody: anthropicBasic });
    const record = buildLharRecord(entry, []);
    assert.equal(record.raw.request_body, null);
    assert.equal(record.raw.response_body, null);
  });
});

describe("toLharJsonl privacy levels", () => {
  const convos = new Map<string, Conversation>();
  convos.set("test-convo-1", {
    id: "test-convo-1",
    label: "Test",
    source: "claude",
    workingDirectory: "/tmp",
    firstSeen: "2026-02-08T12:00:00Z",
  });

  it("full privacy: JSONL entries include raw bodies", () => {
    const entry = makeEntry({ rawBody: anthropicBasic });
    const jsonl = toLharJsonl([entry], convos, "full");
    const lines = jsonl.trim().split("\n");
    const entryLine = lines.find((l) => JSON.parse(l).type === "entry");
    assert.ok(entryLine);
    const parsed = JSON.parse(entryLine!);
    assert.ok(parsed.raw.request_body !== null);
  });

  it("standard privacy: JSONL entries have null raw bodies", () => {
    const entry = makeEntry({ rawBody: anthropicBasic });
    const jsonl = toLharJsonl([entry], convos, "standard");
    const lines = jsonl.trim().split("\n");
    const entryLine = lines.find((l) => JSON.parse(l).type === "entry");
    assert.ok(entryLine);
    const parsed = JSON.parse(entryLine!);
    assert.equal(parsed.raw.request_body, null);
    assert.equal(parsed.raw.response_body, null);
  });
});

describe("toLharJson privacy levels", () => {
  const convos = new Map<string, Conversation>();
  convos.set("test-convo-1", {
    id: "test-convo-1",
    label: "Test",
    source: "claude",
    workingDirectory: "/tmp",
    firstSeen: "2026-02-08T12:00:00Z",
  });

  it("full privacy: JSON entries include raw bodies", () => {
    const entry = makeEntry({ rawBody: anthropicBasic });
    const result = toLharJson([entry], convos, "full");
    assert.ok(result.lhar.entries[0].raw.request_body !== null);
  });

  it("standard privacy: JSON entries have null raw bodies", () => {
    const entry = makeEntry({ rawBody: anthropicBasic });
    const result = toLharJson([entry], convos, "standard");
    assert.equal(result.lhar.entries[0].raw.request_body, null);
  });
});
