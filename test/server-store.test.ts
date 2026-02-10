import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
});
