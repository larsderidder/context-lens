import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Hono } from "hono";
import { parseContextInfo } from "../src/core.js";
import type { StoreChangeEvent } from "../src/server/store.js";
import { Store } from "../src/server/store.js";
import { createApp } from "../src/server/webui.js";

function sanitizeFilenamePart(input: string): string {
  return String(input || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function makeStore(): { store: Store; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "context-lens-test-"));
  const store = new Store({
    dataDir: path.join(dir, "data"),
    stateFile: path.join(dir, "data", "state.jsonl"),
    maxSessions: 10,
    maxCompactMessages: 60,
  });
  return {
    store,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

describe("webui handler", () => {
  let store: Store;
  let app: Hono;
  let cleanup: () => void;

  beforeEach(() => {
    const made = makeStore();
    store = made.store;
    cleanup = made.cleanup;
    app = createApp(store, "<html>ok</html>");
  });

  afterEach(() => {
    if (cleanup) cleanup();
  });

  it("POST /api/ingest stores an entry and GET /api/requests returns it", async () => {
    const ingest = {
      provider: "anthropic",
      apiFormat: "anthropic-messages",
      source: "claude",
      body: {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "from ingest" }],
      },
      response: {
        model: "claude-sonnet-4-20250514",
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    };

    const res = await app.request("/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ingest),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);

    const reqs = await app.request("/api/requests");
    assert.equal(reqs.status, 200);
    const data = await reqs.json();
    assert.ok(Array.isArray(data.conversations));
    const totalEntries =
      (data.conversations || []).reduce(
        (sum: number, c: any) => sum + (c.entries?.length || 0),
        0,
      ) + (data.ungrouped?.length || 0);
    assert.equal(totalEntries, 1);
  });

  it("GET /api/export/lhar returns JSONL and POST /api/reset clears state", async () => {
    // Ingest one entry
    await app.request("/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "anthropic",
        apiFormat: "anthropic-messages",
        source: "claude",
        body: {
          model: "claude-sonnet-4-20250514",
          metadata: { user_id: "session_123" },
          messages: [{ role: "user", content: "hi" }],
        },
        response: {
          model: "claude-sonnet-4-20250514",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      }),
    });

    const exp = await app.request("/api/export/lhar");
    assert.equal(exp.status, 200);
    assert.equal(
      exp.headers.get("Content-Disposition"),
      'attachment; filename="context-lens-export-session-all-privacy-standard.lhar"',
    );
    const expText = await exp.text();
    assert.ok(expText.includes('"type":"entry"'));

    const reqsBefore = await app.request("/api/requests");
    const dataBefore = await reqsBefore.json();
    assert.equal(dataBefore.conversations.length, 1);
    const convoId = dataBefore.conversations[0].id;

    const expScoped = await app.request(
      `/api/export/lhar.json?conversation=${encodeURIComponent(convoId)}&privacy=minimal`,
    );
    assert.equal(expScoped.status, 200);
    const safeConvoId = sanitizeFilenamePart(convoId);
    assert.equal(
      expScoped.headers.get("Content-Disposition"),
      `attachment; filename="context-lens-export-session-${safeConvoId}-privacy-minimal.lhar.json"`,
    );

    const reset = await app.request("/api/reset", { method: "POST" });
    assert.equal(reset.status, 200);

    const reqs = await app.request("/api/requests");
    const data = await reqs.json();
    assert.equal((data.conversations || []).length, 0);
    assert.equal((data.ungrouped || []).length, 0);
  });

  it("DELETE /api/conversations/:id removes a conversation", async () => {
    await app.request("/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "anthropic",
        apiFormat: "anthropic-messages",
        source: "claude",
        body: {
          model: "claude-sonnet-4-20250514",
          metadata: {
            user_id: "session_550e8400-e29b-41d4-a716-446655440000",
          },
          messages: [{ role: "user", content: "hi" }],
        },
        response: {
          model: "claude-sonnet-4-20250514",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      }),
    });

    const reqs = await app.request("/api/requests");
    const data = await reqs.json();
    assert.equal(data.conversations.length, 1);
    const convoId = data.conversations[0].id;

    const del = await app.request(
      `/api/conversations/${encodeURIComponent(convoId)}`,
      { method: "DELETE" },
    );
    assert.equal(del.status, 200);
    assert.equal((await del.json()).ok, true);

    const reqs2 = await app.request("/api/requests");
    const data2 = await reqs2.json();
    assert.equal(data2.conversations.length, 0);
  });
});

describe("Store change events", () => {
  let store: Store;
  let cleanup: () => void;

  beforeEach(() => {
    const dir = mkdtempSync(path.join(tmpdir(), "context-lens-test-"));
    store = new Store({
      dataDir: path.join(dir, "data"),
      stateFile: path.join(dir, "data", "state.jsonl"),
      maxSessions: 10,
      maxCompactMessages: 60,
    });
    cleanup = () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    };
  });

  afterEach(() => {
    if (cleanup) cleanup();
  });

  it("emits entry-added on storeRequest", () => {
    const events: StoreChangeEvent[] = [];
    store.on("change", (e) => events.push(e));

    const ci = parseContextInfo(
      "anthropic",
      {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "test" }],
      },
      "anthropic-messages",
    );
    store.storeRequest(ci, { raw: true }, "test");

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "entry-added");
    assert.equal(events[0].revision, 1);
  });

  it("emits conversation-deleted on deleteConversation", () => {
    const ci = parseContextInfo(
      "anthropic",
      {
        model: "claude-sonnet-4-20250514",
        metadata: { user_id: "session_del-test" },
        messages: [{ role: "user", content: "hi" }],
      },
      "anthropic-messages",
    );
    store.storeRequest(
      ci,
      {
        model: "claude-sonnet-4-20250514",
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 2 },
      },
      "test",
      {
        model: "claude-sonnet-4-20250514",
        metadata: { user_id: "session_del-test" },
        messages: [{ role: "user", content: "hi" }],
      },
    );

    const convos = Array.from(store.getConversations().keys());
    assert.equal(convos.length, 1);
    const convoId = convos[0];

    const events: StoreChangeEvent[] = [];
    store.on("change", (e) => events.push(e));
    store.deleteConversation(convoId);

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "conversation-deleted");
    assert.equal(events[0].conversationId, convoId);
  });

  it("emits reset on resetAll", () => {
    const events: StoreChangeEvent[] = [];
    store.on("change", (e) => events.push(e));
    store.resetAll();

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "reset");
  });

  it("off() removes a listener", () => {
    const events: StoreChangeEvent[] = [];
    const listener = (e: StoreChangeEvent) => events.push(e);
    store.on("change", listener);
    store.resetAll();
    assert.equal(events.length, 1);

    store.off("change", listener);
    store.resetAll();
    assert.equal(events.length, 1); // no new event
  });
});
