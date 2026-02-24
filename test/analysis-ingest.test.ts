import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { ingestCapture } from "../src/analysis/ingest.js";
import type { CaptureData } from "../src/proxy/capture.js";
import { Store } from "../src/server/store.js";

function makeCaptureData(overrides?: Partial<CaptureData>): CaptureData {
  return {
    timestamp: new Date().toISOString(),
    method: "POST",
    path: "/v1/messages",
    source: "claude",
    provider: "anthropic",
    apiFormat: "anthropic-messages",
    targetUrl: "https://api.anthropic.com/v1/messages",
    requestHeaders: { "content-type": "application/json" },
    requestBody: {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Hello world" }],
    },
    requestBytes: 200,
    responseStatus: 200,
    responseHeaders: { "content-type": "application/json" },
    responseBody: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      stop_reason: "end_turn",
      usage: { input_tokens: 50, output_tokens: 20 },
    }),
    responseIsStreaming: false,
    responseBytes: 150,
    timings: { send_ms: 5, wait_ms: 100, receive_ms: 20, total_ms: 125 },
    sessionId: null,
    ...overrides,
  };
}

describe("analysis/ingest", () => {
  let store: Store;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ingest-test-"));
    store = new Store({
      dataDir: path.join(dir, "data"),
      stateFile: path.join(dir, "data", "state.jsonl"),
      maxSessions: 10,
      maxCompactMessages: 60,
    });
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  it("ingests a capture and stores it", () => {
    const capture = makeCaptureData();
    ingestCapture(store, capture);

    const requests = store.getCapturedRequests();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].source, "claude");
    assert.equal(requests[0].contextInfo.model, "claude-sonnet-4-20250514");
    assert.equal(requests[0].contextInfo.provider, "anthropic");
    assert.equal(requests[0].httpStatus, 200);
  });

  it("ingests streaming responses", () => {
    const sseBody = [
      'data: {"type":"message_start","message":{"model":"claude-sonnet-4","usage":{"input_tokens":10}}}',
      'data: {"type":"message_delta","usage":{"output_tokens":5}}',
      "",
    ].join("\n");

    const capture = makeCaptureData({
      responseBody: sseBody,
      responseIsStreaming: true,
    });
    ingestCapture(store, capture);

    const requests = store.getCapturedRequests();
    assert.equal(requests.length, 1);
  });

  it("ingests non-JSON requests as raw", () => {
    const capture = makeCaptureData({
      requestBody: null,
      responseBody: "raw response",
    });
    ingestCapture(store, capture);

    const requests = store.getCapturedRequests();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].contextInfo.apiFormat, "raw");
  });

  it("preserves timings and byte counts", () => {
    const capture = makeCaptureData({
      requestBytes: 1234,
      responseBytes: 5678,
      timings: { send_ms: 1, wait_ms: 2, receive_ms: 3, total_ms: 6 },
    });
    ingestCapture(store, capture);

    const requests = store.getCapturedRequests();
    assert.equal(requests[0].requestBytes, 1234);
    assert.equal(requests[0].responseBytes, 5678);
    assert.equal(requests[0].timings?.total_ms, 6);
  });

  it("computes health score and security alerts", () => {
    const capture = makeCaptureData();
    ingestCapture(store, capture);

    const requests = store.getCapturedRequests();
    assert.ok(requests[0].healthScore);
    assert.ok(requests[0].healthScore!.overall >= 0);
    assert.ok(Array.isArray(requests[0].securityAlerts));
  });

  it("groups captures into conversations", () => {
    // Same system prompt + first user message = same conversation
    ingestCapture(store, makeCaptureData());
    ingestCapture(
      store,
      makeCaptureData({
        requestBody: {
          model: "claude-sonnet-4-20250514",
          messages: [
            { role: "user", content: "Hello world" },
            { role: "assistant", content: "Hi!" },
            { role: "user", content: "Follow up" },
          ],
        },
      }),
    );

    const requests = store.getCapturedRequests();
    assert.equal(requests.length, 2);
    // Both should be in the same conversation
    assert.ok(requests[0].conversationId);
    assert.equal(requests[0].conversationId, requests[1].conversationId);
  });

  it("handles Gemini model-in-URL extraction", () => {
    const capture = makeCaptureData({
      provider: "gemini",
      apiFormat: "gemini",
      path: "/v1beta/models/gemini-2.0-flash:generateContent",
      requestBody: {
        contents: [{ role: "user", parts: [{ text: "Hi" }] }],
      },
    });
    ingestCapture(store, capture);

    const requests = store.getCapturedRequests();
    assert.equal(requests[0].contextInfo.model, "gemini-2.0-flash");
  });
});
