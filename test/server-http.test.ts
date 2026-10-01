import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import { serve } from "@hono/node-server";

import { Store } from "../src/server/store.js";
import { createApp } from "../src/server/webui.js";

const payload = {
  provider: "anthropic",
  apiFormat: "anthropic-messages",
  source: "http-test",
  body: {
    model: "claude-sonnet-4",
    messages: [{ role: "user", content: "Synthetic HTTP request" }],
  },
};

/** Read complete SSE frames even when the HTTP adapter splits or combines chunks. */
async function* readEvents(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      pending += decoder.decode(value, { stream: true });
      let boundary = pending.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (data) {
          yield JSON.parse(data.slice(6)) as { type: string; revision: number };
        }
        boundary = pending.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

describe("analysis HTTP adapter", { timeout: 10000 }, () => {
  let dir: string;
  let store: Store;
  let server: ReturnType<typeof serve>;
  let baseUrl: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "context-lens-http-test-"));
    store = new Store({
      dataDir: path.join(dir, "data"),
      stateFile: path.join(dir, "data", "state.jsonl"),
      maxSessions: 10,
      maxCompactMessages: 60,
    });
    const uiDir = path.join(dir, "ui", "dist");
    mkdirSync(uiDir, { recursive: true });
    writeFileSync(
      path.join(uiDir, "index.html"),
      "<html><body>Test UI</body></html>",
    );
    writeFileSync(path.join(uiDir, "app.js"), "window.testBundle = true;");
    const app = createApp(store, "fallback", path.join(dir, "dist"));
    await new Promise<void>((resolve) => {
      server = serve(
        { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
        (info) => {
          baseUrl = `http://127.0.0.1:${info.port}`;
          resolve();
        },
      );
    });
  });

  afterEach(async () => {
    if ("closeAllConnections" in server) {
      server.closeAllConnections();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it("ingests JSON over a socket and returns the stored request", async () => {
    const res = await fetch(`${baseUrl}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    const summary = await fetch(`${baseUrl}/api/requests?summary=true`);
    assert.match(
      summary.headers.get("content-type") ?? "",
      /application\/json/,
    );
    const data = await summary.json();
    assert.equal(data.conversations.length, 1);
    assert.equal(data.conversations[0].entryCount, 1);
    assert.equal(data.conversations[0].source, "http-test");
  });

  it("serves JavaScript assets and the SPA fallback through the adapter", async () => {
    const asset = await fetch(`${baseUrl}/app.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") ?? "", /javascript/);
    assert.equal(await asset.text(), "window.testBundle = true;");
    const page = await fetch(`${baseUrl}/inspector/synthetic-session`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(await page.text(), "<html><body>Test UI</body></html>");
  });

  it("returns a client error for malformed JSON over a socket", async () => {
    const res = await fetch(`${baseUrl}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Invalid JSON" });
    assert.equal(store.getCapturedRequests().length, 0);
  });

  it("streams updates, removes disconnected listeners, and accepts a reconnect", async (t) => {
    const subscribe = t.mock.method(store, "on");
    const unsubscribe = t.mock.method(store, "off");
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/events`, {
      signal: controller.signal,
    });
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.ok(res.body);
    const events = readEvents(res.body);
    try {
      const connected = await events.next();
      assert.equal(connected.value?.type, "connected");
      const ingest = await fetch(`${baseUrl}/api/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      await ingest.arrayBuffer();
      const update = await events.next();
      assert.equal(update.value?.type, "entry-added");
      assert.ok(
        (update.value?.revision ?? 0) > (connected.value?.revision ?? 0),
      );
    } finally {
      await events.return();
      controller.abort();
    }
    // Disconnect cleanup is dispatched asynchronously by Node's HTTP adapter.
    for (
      let attempt = 0;
      attempt < 100 && unsubscribe.mock.callCount() === 0;
      attempt++
    ) {
      await setImmediate();
    }
    assert.equal(unsubscribe.mock.callCount(), 1);
    assert.equal(
      unsubscribe.mock.calls[0].arguments[1],
      subscribe.mock.calls[0].arguments[1],
    );

    const reconnectController = new AbortController();
    const reconnect = await fetch(`${baseUrl}/api/events`, {
      signal: reconnectController.signal,
    });
    assert.ok(reconnect.body);
    const reconnectedEvents = readEvents(reconnect.body);
    try {
      const connected = await reconnectedEvents.next();
      assert.equal(connected.value?.type, "connected");
      assert.equal(connected.value?.revision, store.getRevision());
    } finally {
      await reconnectedEvents.return();
      reconnectController.abort();
    }
  });
});
